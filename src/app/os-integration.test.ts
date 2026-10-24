import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// "Open in Oarlock" on folders and Oarlock under Open With for text and code
// files, on every OS, without Oarlock ever making itself the default app.
const TAURI = fileURLToPath(new URL("../../src-tauri/", import.meta.url));
const read = (path: string) => readFileSync(`${TAURI}${path}`, "utf8");

const hooks = read("installer-hooks.nsh");
const plist = read("Info.plist");
const desktop = read("linux/oarlock.desktop");

function nsisMacro(name: string): string {
  const match = hooks.match(
    new RegExp(`^!macro ${name}\\b[^\\n]*\\n([\\s\\S]*?)^!macroend`, "m"),
  );
  if (!match) throw new Error(`installer-hooks.nsh has no ${name}`);
  return match[1];
}

function insertedArgs(body: string, macro: string): string[] {
  return [...body.matchAll(new RegExp(`!insertmacro ${macro} "([^"]+)"`, "g"))]
    .map((m) => m[1])
    .sort();
}

const windowsTypes = [
  ...nsisMacro("OARLOCK_TEXT_TYPES").matchAll(/!insertmacro \$\{MACRO\} (\S+)/g),
].map((m) => m[1]);

const documentTypes = plist
  .slice(plist.indexOf("<key>CFBundleDocumentTypes</key>"))
  .split("<dict>")
  .slice(1);

function plistStrings(type: string, key: string): string[] {
  const array = type.match(
    new RegExp(`<key>${key}</key>\\s*<array>([\\s\\S]*?)</array>`),
  );
  return [...(array?.[1] ?? "").matchAll(/<string>([^<]*)<\/string>/g)].map(
    (m) => m[1],
  );
}

describe("bundle config", () => {
  it("declares no Tauri file associations", () => {
    // Tauri's NSIS template writes each associated extension's default
    // value, making Oarlock the default app for all of them.
    for (const file of [
      "tauri.conf.json",
      "tauri.windows.conf.json",
      "tauri.linux.conf.json",
    ]) {
      expect(JSON.parse(read(file)).bundle?.fileAssociations).toBeUndefined();
    }
  });

  it("builds the deb and rpm desktop entries from the Oarlock template", () => {
    const { linux } = JSON.parse(read("tauri.conf.json")).bundle;
    expect(linux.deb.desktopTemplate).toBe("./linux/oarlock.desktop");
    expect(linux.rpm.desktopTemplate).toBe("./linux/oarlock.desktop");
  });
});

describe("Windows installer hooks", () => {
  it("offers Oarlock for the same text and code types as macOS", () => {
    const macTypes = documentTypes.flatMap((t) =>
      plistStrings(t, "CFBundleTypeExtensions"),
    );
    expect(windowsTypes.length).toBeGreaterThan(40);
    expect(new Set(windowsTypes).size).toBe(windowsTypes.length);
    expect([...windowsTypes].sort()).toEqual([...macTypes].sort());
  });

  it("only lists Oarlock for a type and never takes its default", () => {
    expect(hooks).not.toMatch(/Classes\\\*/);
    const list = nsisMacro("OARLOCK_LIST_TYPE");
    const writes = list.split("\n").filter((line) => /WriteReg/.test(line));
    expect(writes).toHaveLength(2);
    expect(writes[0]).toMatch(
      /^\s*WriteRegNone HKCU "Software\\Classes\\\.\$\{EXT\}\\OpenWithProgids" "\$\{OARLOCK_PROGID\}"$/,
    );
    expect(writes[1]).toMatch(
      /"\$\{OARLOCK_APP_KEY\}\\SupportedTypes" "\.\$\{EXT\}" ""$/,
    );
    // Nothing writes an extension's default value or keeps a backup of one.
    expect(hooks).not.toMatch(
      /WriteReg\w+ HKCU "Software\\Classes\\\.\$\{EXT\}" "(?:[^"]*_backup)?"/,
    );
  });

  it("removes on uninstall everything the install writes", () => {
    const install = nsisMacro("NSIS_HOOK_POSTINSTALL");
    const uninstall = nsisMacro("NSIS_HOOK_POSTUNINSTALL");
    expect(insertedArgs(install, "OARLOCK_ADD_FOLDER_VERB")).toEqual([
      "Directory",
      "Directory\\Background",
      "Drive",
    ]);
    expect(insertedArgs(uninstall, "OARLOCK_REMOVE_FOLDER_VERB")).toEqual(
      insertedArgs(install, "OARLOCK_ADD_FOLDER_VERB"),
    );
    expect(install).toContain("OARLOCK_TEXT_TYPES OARLOCK_LIST_TYPE");
    expect(uninstall).toContain("OARLOCK_TEXT_TYPES OARLOCK_UNLIST_TYPE");
    for (const key of [
      /DeleteRegKey HKCU "Software\\Classes\\\$\{OARLOCK_PROGID\}"\n/,
      /DeleteRegKey HKCU "\$\{OARLOCK_APP_KEY\}"\n/,
    ]) {
      expect(install).toMatch(key);
      expect(uninstall).toMatch(key);
    }
  });
});

describe("macOS document types", () => {
  it("offers folders and text but never claims the default", () => {
    expect(documentTypes.length).toBe(3);
    for (const type of documentTypes) {
      expect(type).toMatch(
        /<key>LSHandlerRank<\/key>\s*<string>Alternate<\/string>/,
      );
    }
    const contentTypes = documentTypes.flatMap((t) =>
      plistStrings(t, "LSItemContentTypes"),
    );
    expect(contentTypes).toContain("public.folder");
    expect(contentTypes).toContain("public.plain-text");
    for (const everyFile of [
      "public.item",
      "public.content",
      "public.data",
      "public.directory",
    ]) {
      expect(contentTypes).not.toContain(everyFile);
    }
  });
});

describe("Linux desktop entry", () => {
  it("passes the opened files and offers Oarlock for folders and text", () => {
    expect(desktop).toMatch(/^Exec=\{\{exec\}\} %F$/m);
    // GIO makes an app that names a type itself its default ahead of the
    // desktop's text/plain default, so code types come through text/plain.
    expect(desktop).toMatch(/^MimeType=inode\/directory;text\/plain;$/m);
  });
});
