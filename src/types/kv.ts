// Shared Key-Value Store Types
// Decoupled from Deno.Kv to support multiple runtimes (Node, Bun, Deno)

export type KvKeyPart = string | number | bigint | boolean | Uint8Array;
export type KvKey = readonly KvKeyPart[];

export interface KvEntry<T> {
    key: KvKey;
    value: T;
    versionstamp: string;
}

export interface KvEntryMaybe<T> {
    key: KvKey;
    value: T | null;
    versionstamp: string | null;
}

export type KvConsistencyLevel = "strong" | "eventual";

export interface KvListSelector {
    prefix?: KvKey;
    start?: KvKey;
    end?: KvKey;
}

export interface KvListOptions {
    limit?: number;
    cursor?: string;
    reverse?: boolean;
    consistency?: KvConsistencyLevel;
}

export interface KvListIterator<T> extends AsyncIterable<KvEntry<T>> {
    readonly cursor: string;
}

export interface KvCommitResult {
    ok: boolean;
    versionstamp?: string;
}

export interface KvAtomicOperation {
    check(...checks: { key: KvKey; versionstamp: string | null }[]): this;
    mutate(...mutations: unknown[]): this;
    sum(key: KvKey, n: bigint): this;
    set(key: KvKey, value: unknown, options?: { expireIn?: number }): this;
    delete(key: KvKey): this;
    commit(): Promise<KvCommitResult | null>;
}

export interface Kv {
    get<T = unknown>(key: KvKey): Promise<KvEntryMaybe<T>>;
    getMany<T extends readonly unknown[]>(
        keys: readonly KvKey[],
    ): Promise<{ [K in keyof T]: KvEntryMaybe<T[K]> }>;
    set(
        key: KvKey,
        value: unknown,
        options?: { expireIn?: number },
    ): Promise<KvCommitResult>;
    delete(key: KvKey): Promise<void>;
    list<T = unknown>(
        selector: KvListSelector,
        options?: KvListOptions,
    ): KvListIterator<T>;
    atomic(): KvAtomicOperation;
    watch?(
        keys: readonly KvKey[],
        options?: { raw?: boolean },
    ): ReadableStream<KvEntryMaybe<unknown>[]>;
    enqueue(
        value: unknown,
        options?: {
            delay?: number;
            keysIfUndelivered?: KvKey[];
            backoffSchedule?: number[];
        },
    ): Promise<KvCommitResult>;
    listenQueue(handler: (value: unknown) => Promise<void> | void): Promise<void>;
    commitVersionstamp?(): symbol;
    close(): void;
    [Symbol.dispose](): void;
}
