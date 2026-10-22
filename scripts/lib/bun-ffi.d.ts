// The part of Bun's `bun:ffi` the macOS harnesses use (the repository does not depend on
// bun-types). Arguments typed "ptr" accept a TypedArray, which Bun passes as its data pointer.
declare module "bun:ffi" {
  type FFITypeName = "i32" | "u32" | "i64" | "u64" | "ptr" | "void";
  type Signature = {
    readonly args?: readonly FFITypeName[];
    readonly returns?: FFITypeName;
  };
  export function dlopen<Symbols extends Record<string, Signature>>(
    path: string,
    symbols: Symbols,
  ): {
    symbols: { [Name in keyof Symbols]: (...args: unknown[]) => unknown };
    close(): void;
  };
}
