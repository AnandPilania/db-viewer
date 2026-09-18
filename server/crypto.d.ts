declare const DATA_DIR: string;
/** True when the key came from the generated local file rather than an injected secret. */
export declare const usingLocalKeyFile: boolean;
export declare function encrypt(plaintext: string): string;
export declare function decrypt(payload: string): string;
export { DATA_DIR };
