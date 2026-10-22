import { SchemeError } from "./scheme";

export type PlistValue =
  | string
  | number
  | boolean
  | PlistValue[]
  | { [key: string]: PlistValue };

type Tag = { name: string; closing: boolean; selfClosing: boolean };

const MAX_DEPTH = 32;

const ENTITIES = new Map([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
]);

function decodeEntities(text: string): string {
  return text.replace(
    /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,
    (whole, body: string) => {
      if (body[0] === "#") {
        const code =
          body[1] === "x" || body[1] === "X"
            ? Number.parseInt(body.slice(2), 16)
            : Number.parseInt(body.slice(1), 10);
        return code <= 0x10ffff ? String.fromCodePoint(code) : whole;
      }
      return ENTITIES.get(body.toLowerCase()) ?? whole;
    },
  );
}

/**
 * Reads the XML property list subset `.itermcolors` files use (dict, array,
 * key, string, real, integer, true, false, date, data) without a DOM, so it
 * runs anywhere and never resolves external entities.
 */
class PlistReader {
  private pos = 0;

  constructor(private readonly src: string) {}

  parseDocument(): PlistValue {
    this.skipMarkup();
    let tag = this.readTag();
    const wrapped = tag.name === "plist" && !tag.closing;
    if (wrapped) {
      if (tag.selfClosing) throw this.error("the property list is empty");
      this.skipMarkup();
      tag = this.readTag();
    }
    const value = this.readValue(tag, 0);
    if (wrapped) {
      this.skipMarkup();
      this.expectClose("plist");
    }
    return value;
  }

  private error(message: string): SchemeError {
    return new SchemeError(`Invalid property list: ${message}`);
  }

  private skipMarkup(): void {
    for (;;) {
      while (this.pos < this.src.length && /\s/.test(this.src[this.pos])) {
        this.pos++;
      }
      if (this.src.startsWith("<!--", this.pos)) this.skipPast("-->");
      else if (this.src.startsWith("<?", this.pos)) this.skipPast("?>");
      else if (this.src.startsWith("<!", this.pos)) this.skipPast(">");
      else return;
    }
  }

  private skipPast(terminator: string): void {
    const end = this.src.indexOf(terminator, this.pos);
    if (end < 0) throw this.error(`missing "${terminator}"`);
    this.pos = end + terminator.length;
  }

  private readTag(): Tag {
    if (this.src[this.pos] !== "<") throw this.error("expected an element");
    const end = this.src.indexOf(">", this.pos);
    if (end < 0) throw this.error("unterminated element");
    let body = this.src.slice(this.pos + 1, end).trim();
    this.pos = end + 1;
    const closing = body.startsWith("/");
    if (closing) body = body.slice(1);
    const selfClosing = body.endsWith("/");
    if (selfClosing) body = body.slice(0, -1);
    const name = body.split(/\s/, 1)[0];
    if (!name) throw this.error("empty element name");
    return { name, closing, selfClosing };
  }

  private expectClose(name: string): void {
    const tag = this.readTag();
    if (!tag.closing || tag.name !== name) {
      throw this.error(
        `expected </${name}>, found <${tag.closing ? "/" : ""}${tag.name}>`,
      );
    }
  }

  private readText(tag: Tag): string {
    if (tag.selfClosing) return "";
    const end = this.src.indexOf("<", this.pos);
    if (end < 0) throw this.error(`unterminated <${tag.name}>`);
    const text = decodeEntities(this.src.slice(this.pos, end));
    this.pos = end;
    this.expectClose(tag.name);
    return text;
  }

  private readValue(tag: Tag, depth: number): PlistValue {
    if (tag.closing) throw this.error(`unexpected </${tag.name}>`);
    if (depth > MAX_DEPTH) throw this.error("nested too deeply");
    switch (tag.name) {
      case "dict":
        return this.readDict(tag, depth);
      case "array":
        return this.readArray(tag, depth);
      case "string":
      case "date":
      case "data":
        return this.readText(tag);
      case "real":
      case "integer": {
        const text = this.readText(tag).trim();
        const value = Number(text);
        if (text === "" || !Number.isFinite(value)) {
          throw this.error(`"${text.slice(0, 32)}" is not a number`);
        }
        return value;
      }
      case "true":
      case "false":
        if (!tag.selfClosing) this.expectClose(tag.name);
        return tag.name === "true";
      default:
        throw this.error(`unsupported element <${tag.name}>`);
    }
  }

  private readDict(tag: Tag, depth: number): { [key: string]: PlistValue } {
    const out = Object.create(null) as { [key: string]: PlistValue };
    if (tag.selfClosing) return out;
    for (;;) {
      this.skipMarkup();
      const keyTag = this.readTag();
      if (keyTag.closing && keyTag.name === "dict") return out;
      if (keyTag.name !== "key" || keyTag.closing) {
        throw this.error(`expected <key> in <dict>, found <${keyTag.name}>`);
      }
      const key = this.readText(keyTag);
      this.skipMarkup();
      out[key] = this.readValue(this.readTag(), depth + 1);
    }
  }

  private readArray(tag: Tag, depth: number): PlistValue[] {
    const out: PlistValue[] = [];
    if (tag.selfClosing) return out;
    for (;;) {
      this.skipMarkup();
      const item = this.readTag();
      if (item.closing && item.name === "array") return out;
      out.push(this.readValue(item, depth + 1));
    }
  }
}

export function parsePlist(xml: string): PlistValue {
  return new PlistReader(xml).parseDocument();
}
