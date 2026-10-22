// wawoff2 ships no type declarations; these are the two functions it exports.
declare module "wawoff2" {
  /** TrueType/OpenType font to WOFF2 (Google's woff2 encoder). */
  export function compress(font: Uint8Array): Promise<Uint8Array>;
  /** WOFF2 back to the TrueType/OpenType font it encodes. */
  export function decompress(font: Uint8Array): Promise<Uint8Array>;
}
