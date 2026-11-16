/**
 * The outbox: where the program that does a job leaves files to go with its
 * delivery.
 *
 * The program cannot publish anything itself: publishing is signed with the
 * agent's key, which only the wallet holds. So it leaves each file in the
 * agent's outbox, named by the file's sha-256, and lists the files at the
 * end of the delivery text (`client/delivery-files.ts`). When the delivery
 * is published, the files it lists are published first. A file that cannot
 * be published stops the delivery: a job is never handed in with a file
 * missing.
 *
 * Only files the delivery text names are published. Anything else found in
 * the outbox is from a job that did not finish, and is thrown away.
 */

import { lstatSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { MAX_DELIVERY_FILE_BYTES, MAX_DELIVERY_FILES } from "./client/delivery-files.js";

const SHA256_NAME = /^[0-9a-f]{64}$/;

/** Make the outbox, private to this user. */
export function prepareOutbox(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function refuse(status: number): Response {
  return new Response(null, { status });
}

/**
 * An upload that also publishes the outbox. `upload` is the store's own
 * upload (it takes the bytes as the request body and answers 2xx when they
 * are kept); the result is used in its place for publishing a delivery.
 */
export function publishingOutbox(upload: typeof fetch, outboxDir: string): typeof fetch {
  return async (input, init) => {
    const body = init?.body;
    let names: string[] = [];
    try {
      names = readdirSync(outboxDir);
    } catch {
      // No outbox yet: a delivery with no files.
    }
    if (names.length === 0 || !(body instanceof Uint8Array)) return upload(input, init);

    const text = Buffer.from(body).toString("latin1");
    const listed = names.filter((name) => SHA256_NAME.test(name) && text.includes(name)).sort();
    if (listed.length > MAX_DELIVERY_FILES) return refuse(413);
    for (const name of listed) {
      const file = path.join(outboxDir, name);
      let bytes: Uint8Array;
      try {
        const info = lstatSync(file);
        if (!info.isFile() || info.size === 0 || info.size > MAX_DELIVERY_FILE_BYTES) return refuse(413);
        bytes = new Uint8Array(readFileSync(file));
      } catch {
        return refuse(422);
      }
      // The name is a promise about the content; a file that breaks it is not published.
      if (createHash("sha256").update(bytes).digest("hex") !== name) return refuse(422);
      const kept = await upload(input, { method: "POST", body: bytes as unknown as NonNullable<RequestInit["body"]> });
      if (!kept.ok) return refuse(kept.status >= 400 ? kept.status : 502);
    }
    const answer = await upload(input, init);
    if (answer.ok) {
      for (const name of names) rmSync(path.join(outboxDir, name), { recursive: true, force: true });
    }
    return answer;
  };
}
