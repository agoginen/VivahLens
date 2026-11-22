declare module "fengari" {
  // Fengari ships no type declarations; the harness uses a small part of its API and checks results itself.
  export const lua: any;
  export const lauxlib: any;
  export const lualib: any;
  export function to_luastring(text: string): Uint8Array;
}
