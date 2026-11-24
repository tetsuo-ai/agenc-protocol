// libuv does not expose CreateNamedPipe's ACL or PIPE_REJECT_REMOTE_CLIENTS.
// A fixed Windows helper owns the listener and carries bytes over inherited
// stdio. Node never creates a second, less restricted listener behind it.
import { spawn } from "node:child_process";
import { Duplex } from "node:stream";
import { createInterface } from "node:readline";
import { win32 } from "node:path";
import type { Socket } from "node:net";

const helper = String.raw`
using System;
using System.IO;
using System.IO.Pipes;
using System.Threading;
using System.Collections.Concurrent;
using System.Security.Principal;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class MarketPipe {
  [StructLayout(LayoutKind.Sequential)] struct SA { public int size; public IntPtr descriptor; public int inherit; }
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string s, uint rev, out IntPtr p, IntPtr size);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern SafePipeHandle CreateNamedPipe(string name, uint access, uint mode, uint max, uint output, uint input, uint timeout, ref SA sa);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p);
  [DllImport("userenv.dll", CharSet=CharSet.Unicode)] static extern int DeriveAppContainerSidFromAppContainerName(string name, out IntPtr sid);
  [DllImport("advapi32.dll")] static extern IntPtr FreeSid(IntPtr sid);
  static readonly ConcurrentDictionary<int,NamedPipeServerStream> streams = new ConcurrentDictionary<int,NamedPipeServerStream>();
  static readonly object output = new object();
  static void Emit(string s) { lock(output) { Console.WriteLine(s); Console.Out.Flush(); } }
  static void Close(int id) { NamedPipeServerStream stream; if (streams.TryRemove(id,out stream)) stream.Close(); }
  static void Input() {
    try {
      string line;
      while ((line = Console.ReadLine()) != null) {
        int space = line.IndexOf(' '), id = int.Parse(line.Substring(0,space));
        string body = line.Substring(space+1);
        NamedPipeServerStream f;
        if (body == "-") Close(id);
        else if (streams.TryGetValue(id,out f)) {
          byte[] bytes = Convert.FromBase64String(body);
          try { f.Write(bytes,0,bytes.Length); } catch(IOException) { Close(id); } catch(ObjectDisposedException) {}
        }
      }
    } finally { Environment.Exit(0); }
  }
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetNamedPipeServerProcessId(SafePipeHandle h,out uint pid);
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static void Client(string name) {
    using (NamedPipeClientStream stream = new NamedPipeClientStream(".", name, PipeDirection.InOut, PipeOptions.Asynchronous,TokenImpersonationLevel.Identification)) {
      stream.Connect(4000);
      uint pid;
      if (!GetNamedPipeServerProcessId(stream.SafePipeHandle,out pid)) throw new IOException("Unknown pipe server.");
      IntPtr process = OpenProcess(0x1000,false,pid), token=IntPtr.Zero;
      try {
        if (process==IntPtr.Zero || !OpenProcessToken(process,8,out token)) throw new IOException("Unknown pipe owner.");
        using (WindowsIdentity owner = new WindowsIdentity(token)) {
          if (owner.User.Value != WindowsIdentity.GetCurrent().User.Value) throw new IOException("Different pipe owner.");
        }
      } finally { if(token!=IntPtr.Zero) CloseHandle(token); if(process!=IntPtr.Zero) CloseHandle(process); }
      Emit("ready");
      new Thread(delegate() {
        try { string line; while((line=Console.ReadLine())!=null) { byte[] bytes=Convert.FromBase64String(line);stream.Write(bytes,0,bytes.Length); } }
        catch (IOException) {} finally { stream.Close(); }
      }){IsBackground=true}.Start();
      byte[] data=new byte[16384]; int count;
      while ((count=stream.Read(data,0,data.Length))>0) Emit(Convert.ToBase64String(data,0,count));
    }
  }
  public static void Run(string name, string profile) {
    string sid = WindowsIdentity.GetCurrent().User.Value;
    string acl = "D:P(A;;GA;;;"+sid+")";
    if (profile.Length != 0) {
      IntPtr container;
      if (DeriveAppContainerSidFromAppContainerName(profile,out container) != 0) throw new IOException("AppContainer SID");
      try { acl += "(A;;GRGW;;;"+new SecurityIdentifier(container).Value+")S:(ML;;NW;;;LW)"; }
      finally { FreeSid(container); }
    }
    IntPtr sd;
    if (!ConvertStringSecurityDescriptorToSecurityDescriptor(acl,1,out sd,IntPtr.Zero)) throw new IOException("Pipe ACL");
    try {
      SA sa = new SA(); sa.size = Marshal.SizeOf(sa); sa.descriptor = sd;
      new Thread(Input){IsBackground=true}.Start();
      int next=0;
      while (true) {
        SafePipeHandle h=CreateNamedPipe(name,0x40000003u | (next==0 ? 0x80000u : 0u),8,64,65536,65536,0,ref sa);
        if (h.IsInvalid) throw new IOException("CreateNamedPipe failed: "+Marshal.GetLastWin32Error());
        if(next==0) Emit("ready");
        NamedPipeServerStream stream=new NamedPipeServerStream(PipeDirection.InOut,true,false,h);
        try { stream.WaitForConnection(); } catch(IOException) { stream.Dispose(); continue; }
        int id=++next;
        streams[id]=stream;
        Emit(id+" +");
        new Thread(delegate() {
          try {
            byte[] buffer=new byte[16384]; int count;
            bool checkedUser = false;
            while((count=stream.Read(buffer,0,buffer.Length))>0) {
              if (!checkedUser && profile.Length != 0) {
                bool same = false;
                try { stream.RunAsClient(delegate { same = WindowsIdentity.GetCurrent(true).User.Value == sid; }); } catch {}
                if (!same) break;
                checkedUser = true;
              }
              Emit(id+" "+Convert.ToBase64String(buffer,0,count));
            }
          } catch(IOException) {} catch(ObjectDisposedException) {}
          finally { Close(id); Emit(id+" -"); }
        }){IsBackground=true}.Start();
        while(streams.Count>=63) Thread.Sleep(10);
      }
    } finally { LocalFree(sd); }
  }
}
`;

export async function listenWindowsPipe(
  endpoint: string,
  accept: (socket: Socket) => void,
  profile = "",
): Promise<() => void> {
  const prefix = profile ? "\\\\.\\pipe\\LOCAL\\" : "\\\\.\\pipe\\";
  if (
    (profile && !/^AgenC\.OA[a-f0-9]{24}$/.test(profile)) ||
    !endpoint.startsWith(prefix) ||
    !/^agenc-[a-z0-9-]{1,90}$/i.test(endpoint.slice(prefix.length))
  )
    throw new Error("Invalid Market pipe name.");
  const script =
    "$ErrorActionPreference='Stop'\nAdd-Type -TypeDefinition @'\n" +
    helper +
    "\n'@\n[MarketPipe]::Run('" +
    endpoint +
    "','" +
    profile +
    "')";
  const shell = win32.join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const child = spawn(
    shell,
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
  );
  child.stderr.resume();
  const clients = new Map<string, Duplex>();
  const stop = () => {
    child.kill();
    for (const s of clients.values()) s.destroy();
    clients.clear();
  };
  return new Promise((resolve, reject) => {
    const startup = setTimeout(() => {
      stop();
      reject(new Error("Windows Market pipe startup timed out."));
    }, 30_000);
    child.once("error", (error) => {
      clearTimeout(startup);
      stop();
      reject(error);
    });
    child.once("exit", () => {
      clearTimeout(startup);
      stop();
      reject(new Error("Windows Market pipe stopped."));
    });
    child.stdin.on("error", () => stop());
    createInterface({ input: child.stdout }).on("line", (line) => {
      if (line === "ready") {
        clearTimeout(startup);
        resolve(stop);
        return;
      }
      const i = line.indexOf(" "),
        id = line.slice(0, i),
        content = line.slice(i + 1);
      if (!/^\d+$/.test(id)) return;
      if (content === "+") {
        const stream = new Duplex({
          read() {},
          write(chunk: Buffer, _encoding, done) {
            child.stdin.write(id + " " + chunk.toString("base64") + "\n", done);
          },
          destroy(err, done) {
            clients.delete(id);
            if (child.stdin.writable) child.stdin.write(id + " -\n");
            done(err);
          },
        });
        // HTTP uses the Socket timeout/no-delay API on accepted streams.
        let timer: NodeJS.Timeout | undefined;
        Object.assign(stream, {
          setNoDelay: () => stream,
          setKeepAlive: () => stream,
          setTimeout(ms: number, cb?: () => void) {
            clearTimeout(timer);
            if (cb) stream.once("timeout", cb);
            if (ms > 0)
              timer = setTimeout(() => stream.emit("timeout"), ms).unref();
            return stream;
          },
        });
        stream.once("close", () => clearTimeout(timer));
        clients.set(id, stream);
        accept(stream as Socket);
      } else {
        const stream = clients.get(id);
        if (content === "-") stream?.push(null);
        else if (stream) {
          if (stream.readableLength > 4 * 1024 * 1024) stream.destroy();
          else stream.push(Buffer.from(content, "base64"));
        }
      }
    });
  });
}

/** Verify the user of the server process on the connected handle before sending an owner credential or unlock secret. */
export function connectWindowsPipe(endpoint: string): Socket {
  const prefix = "\\\\.\\pipe\\";
  if (
    !endpoint.startsWith(prefix) ||
    !/^agenc-[a-z0-9-]{1,90}$/i.test(endpoint.slice(prefix.length))
  )
    throw new Error("Invalid wallet pipe name.");
  const script =
    "$ErrorActionPreference='Stop'\nAdd-Type -TypeDefinition @'\n" +
    helper +
    "\n'@\n[MarketPipe]::Client('" +
    endpoint.slice(prefix.length) +
    "')";
  const shell = win32.join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const child = spawn(
    shell,
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
  );
  let verified = false;
  const stream = new Duplex({
    read() {},
    write(bytes: Buffer, _enc, done) {
      if (!verified) {
        done(new Error("The wallet pipe is unverified."));
        return;
      }
      child.stdin.write(bytes.toString("base64") + "\n", done);
    },
    final(done) {
      child.stdin.end();
      done();
    },
    destroy(err, done) {
      child.kill();
      done(err);
    },
  });
  child.stderr.resume();
  child.once("error", (e) => stream.destroy(e));
  child.stdin.on("error", () => stream.destroy());
  child.once("exit", () =>
    verified
      ? stream.destroy()
      : stream.destroy(
          new Error("The wallet did not prove the current Windows user."),
        ),
  );
  createInterface({ input: child.stdout }).on("line", (line) => {
    if (!verified && line === "ready") {
      verified = true;
      stream.emit("connect");
    } else if (verified && stream.readableLength < 4 * 1024 * 1024)
      stream.push(Buffer.from(line, "base64"));
    else stream.destroy();
  });
  return stream as Socket;
}
