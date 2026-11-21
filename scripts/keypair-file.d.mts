// Types for keypair-file.mjs, for TypeScript callers (the SDK's RPC suites).
export declare const PLAIN_KEYPAIR_SHAPE: string;
/** The 64 secret-key bytes of a keypair file's text; errors name `filePath` only. */
export declare function parsePlainKeypairJson(raw: string, filePath: string): Uint8Array;
/** Read a plain keypair file; errors name the path, never the content. */
export declare function readPlainKeypairFile(filePath: string, configured?: string): Uint8Array;
