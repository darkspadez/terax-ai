// Command-line parsing for the developer scripts, with the semantics and help layout of Python's
// argparse that the scripts were written against: `--flag value` and `--flag=value`, int/float
// conversion, choices, `nargs` "+" and "?", repeatable options, `--x/--no-x` pairs, unique-prefix
// abbreviations (unless disabled), `-h/--help`, and usage errors with status 2.

import { basename } from "node:path";
import { SystemExit } from "./errors.ts";
import { parseFloat10, parseInt10, pyRepr } from "./format.ts";

type ValueType = "str" | "int" | "float";

export type OptionSpec = {
  /** The long option, e.g. `--idle-ms`. */
  flag: string;
  help?: string;
  metavar?: string;
  /** store (default), store_true, append (repeatable) or `--x/--no-x` (boolean_optional). */
  action?: "store" | "store_true" | "append" | "boolean_optional";
  type?: ValueType;
  nargs?: "+" | "?";
  /** The value of a `nargs: "?"` option given without one. */
  const?: string;
  choices?: readonly (string | number)[];
  default?: string | number | boolean | null;
};

type Scalar<O> = O extends { type: "int" | "float" } ? number : string;
type Choice<O> = O extends { choices: readonly (infer C)[] } ? C : Scalar<O>;

/** The parsed value of one option; `undefined` where argparse gave None. */
export type ValueOf<O> = O extends { action: "store_true" }
  ? boolean
  : O extends { action: "append" }
    ? string[]
    : O extends { action: "boolean_optional"; default: boolean }
      ? boolean
      : O extends { action: "boolean_optional" }
        ? boolean | undefined
        : O extends { nargs: "+" }
          ? Choice<O>[] | undefined
          : O extends { default: string | number }
            ? Choice<O>
            : Choice<O> | undefined;

export type Parsed<S extends Record<string, OptionSpec>> = {
  -readonly [K in keyof S]: ValueOf<S[K]>;
};

export type ParserOptions = {
  /** Text printed between usage and options, verbatim. */
  description?: string;
  /** argparse's `allow_abbrev`: accept a unique prefix of a long option. */
  allowAbbrev?: boolean;
  prog?: string;
};

const HELP = "\0help";
const NEGATIVE_NUMBER = /^-\d+$|^-\d*\.\d+$/;

function metavarOf(dest: string, spec: OptionSpec): string {
  if (spec.metavar) return spec.metavar;
  if (spec.choices) return `{${spec.choices.join(",")}}`;
  return dest.replace(/[A-Z]/g, (char) => `_${char}`).toUpperCase();
}

function argumentsOf(dest: string, spec: OptionSpec): string {
  const metavar = metavarOf(dest, spec);
  if (spec.action === "store_true" || spec.action === "boolean_optional")
    return "";
  if (spec.nargs === "+") return `${metavar} [${metavar} ...]`;
  if (spec.nargs === "?") return `[${metavar}]`;
  return metavar;
}

function negated(flag: string): string {
  return `--no-${flag.slice(2)}`;
}

function wrap(text: string, width: number): string[] {
  const words = text.trim().split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines;
}

export class ArgumentParser<S extends Record<string, OptionSpec>> {
  private readonly prog: string;
  private readonly flags = new Map<string, [dest: string, negated: boolean]>();

  constructor(
    private readonly specs: S,
    private readonly options: ParserOptions = {},
  ) {
    this.prog = options.prog ?? basename(process.argv[1] ?? "script");
    this.flags.set("-h", [HELP, false]);
    this.flags.set("--help", [HELP, false]);
    for (const [dest, spec] of Object.entries(specs)) {
      this.flags.set(spec.flag, [dest, false]);
      if (spec.action === "boolean_optional")
        this.flags.set(negated(spec.flag), [dest, true]);
    }
  }

  private width(): number {
    const columns = Number(process.env.COLUMNS) || process.stdout.columns || 80;
    return Math.max(columns - 2, 11);
  }

  usage(): string {
    const parts = ["[-h]"];
    for (const [dest, spec] of Object.entries(this.specs)) {
      const flag =
        spec.action === "boolean_optional"
          ? `${spec.flag} | ${negated(spec.flag)}`
          : spec.flag;
      const args = argumentsOf(dest, spec);
      parts.push(`[${flag}${args ? ` ${args}` : ""}]`);
    }
    const prefix = `usage: ${this.prog} `;
    const lines: string[] = [];
    let line = prefix;
    for (const part of parts) {
      if (
        line.length > prefix.length &&
        line.length + part.length > this.width()
      ) {
        lines.push(line.trimEnd());
        line = " ".repeat(prefix.length);
      }
      line += `${part} `;
    }
    lines.push(line.trimEnd());
    return lines.join("\n");
  }

  help(): string {
    const width = this.width();
    const entries: [invocation: string, help: string | undefined][] = [
      ["-h, --help", "show this help message and exit"],
    ];
    for (const [dest, spec] of Object.entries(this.specs)) {
      const args = argumentsOf(dest, spec);
      const invocation =
        spec.action === "boolean_optional"
          ? `${spec.flag}, ${negated(spec.flag)}`
          : `${spec.flag}${args ? ` ${args}` : ""}`;
      entries.push([invocation, spec.help]);
    }
    const longest = Math.max(
      ...entries.map(([invocation]) => invocation.length + 2),
    );
    const position = Math.min(
      longest + 2,
      Math.min(24, Math.max(width - 20, 4)),
    );
    const helpWidth = Math.max(width - position, 11);
    const lines = [this.usage(), ""];
    if (this.options.description) lines.push(this.options.description, "");
    lines.push("options:");
    for (const [invocation, help] of entries) {
      const header = `  ${invocation}`;
      if (!help) {
        lines.push(header);
        continue;
      }
      const text = wrap(help, helpWidth);
      if (invocation.length <= position - 4)
        lines.push(header.padEnd(position) + text[0]);
      else lines.push(header, " ".repeat(position) + text[0]);
      for (const rest of text.slice(1)) lines.push(" ".repeat(position) + rest);
    }
    return lines.join("\n");
  }

  private fail(message: string): never {
    console.error(this.usage());
    console.error(`${this.prog}: error: ${message}`);
    throw new SystemExit(2);
  }

  private convert(spec: OptionSpec, raw: string): string | number {
    const type = spec.type ?? "str";
    let value: string | number | undefined = raw;
    if (type === "int") value = parseInt10(raw);
    else if (type === "float") value = parseFloat10(raw);
    if (value === undefined)
      this.fail(`argument ${spec.flag}: invalid ${type} value: ${pyRepr(raw)}`);
    if (spec.choices && !spec.choices.includes(value))
      this.fail(
        `argument ${spec.flag}: invalid choice: ${pyRepr(value)} (choose from ${spec.choices
          .map((choice) => pyRepr(choice))
          .join(", ")})`,
      );
    return value;
  }

  private abbreviations(name: string): string[] {
    if (this.options.allowAbbrev === false || !name.startsWith("--")) return [];
    return [...this.flags.keys()].filter((flag) => flag.startsWith(name));
  }

  /** argparse's test for an option string (anything else is a value). */
  private isOption(token: string): boolean {
    if (!token.startsWith("-") || token === "-") return false;
    const name = token.includes("=")
      ? token.slice(0, token.indexOf("="))
      : token;
    if (this.flags.has(token) || this.flags.has(name)) return true;
    if (this.abbreviations(name).length) return true;
    if (NEGATIVE_NUMBER.test(token) || token.includes(" ")) return false;
    return true;
  }

  private lookup(token: string): [dest: string, negated: boolean] {
    const exact = this.flags.get(token);
    if (exact) return exact;
    const matches = this.abbreviations(token);
    if (matches.length === 1)
      return this.flags.get(matches[0]) as [string, boolean];
    if (matches.length > 1)
      this.fail(`ambiguous option: ${token} could match ${matches.join(", ")}`);
    return this.fail(`unrecognized arguments: ${token}`);
  }

  /** Parses `argv` (without the runtime and script); prints help and exits on `-h`/`--help`. */
  parse(argv: readonly string[] = process.argv.slice(2)): Parsed<S> {
    const result: Record<string, unknown> = {};
    for (const [dest, spec] of Object.entries(this.specs))
      result[dest] =
        spec.action === "store_true"
          ? (spec.default ?? false)
          : spec.action === "append"
            ? []
            : (spec.default ?? undefined);
    for (let index = 0; index < argv.length; index++) {
      const token = argv[index];
      if (token === "--" || !this.isOption(token))
        this.fail(`unrecognized arguments: ${argv.slice(index).join(" ")}`);
      const equals = this.flags.has(token) ? -1 : token.indexOf("=");
      const name = equals > 0 ? token.slice(0, equals) : token;
      const inline = equals > 0 ? token.slice(equals + 1) : undefined;
      const [dest, negative] = this.lookup(name);
      if (dest === HELP) {
        console.log(this.help());
        throw new SystemExit(0);
      }
      const spec = this.specs[dest];
      if (spec.action === "store_true" || spec.action === "boolean_optional") {
        if (inline !== undefined)
          this.fail(
            `argument ${spec.flag}: ignored explicit argument ${pyRepr(inline)}`,
          );
        result[dest] = !negative;
        continue;
      }
      if (spec.nargs === "?") {
        if (inline !== undefined) result[dest] = this.convert(spec, inline);
        else if (index + 1 < argv.length && !this.isOption(argv[index + 1]))
          result[dest] = this.convert(spec, argv[++index]);
        else result[dest] = spec.const;
        continue;
      }
      if (spec.nargs === "+") {
        const values = inline !== undefined ? [inline] : [];
        while (index + 1 < argv.length && !this.isOption(argv[index + 1]))
          values.push(argv[++index]);
        if (!values.length)
          this.fail(`argument ${spec.flag}: expected at least one argument`);
        result[dest] = values.map((value) => this.convert(spec, value));
        continue;
      }
      let raw = inline;
      if (raw === undefined) {
        if (index + 1 >= argv.length || this.isOption(argv[index + 1]))
          this.fail(`argument ${spec.flag}: expected one argument`);
        raw = argv[++index];
      }
      const value = this.convert(spec, raw);
      if (spec.action === "append") (result[dest] as unknown[]).push(value);
      else result[dest] = value;
    }
    return result as Parsed<S>;
  }
}
