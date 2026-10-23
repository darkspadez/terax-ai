import { describe, expect, it } from "vitest";
import { STRUCT_SIZE, V4_FIELDS, V6_FIELDS } from "./libproc.ts";
import {
  membersFrom,
  parseCpuTime,
  parseProcessTable,
  parseVmmapSummary,
  ROLE_BY_NAME,
  roleOf,
  vmmapBytes,
} from "./procstats.ts";

// Expected values were produced by the earlier Python implementation of this module from the
// same input.

describe("rusage_info layout", () => {
  it("matches <sys/resource.h>: 16-byte uuid, then uint64 fields", () => {
    expect(STRUCT_SIZE[4]).toBe(296);
    expect(STRUCT_SIZE[6]).toBe(464);
    const offset = (name: string) =>
      16 + 8 * (V6_FIELDS as readonly string[]).indexOf(name);
    expect(offset("ri_phys_footprint")).toBe(72);
    expect(offset("ri_proc_start_abstime")).toBe(80);
    expect(offset("ri_instructions")).toBe(248);
    expect(offset("ri_runnable_time")).toBe(288);
    expect(offset("ri_user_ptime")).toBe(304);
    expect(offset("ri_energy_nj")).toBe(336);
    expect(offset("ri_penergy_nj")).toBe(344);
    expect(V6_FIELDS.slice(0, V4_FIELDS.length)).toEqual(V4_FIELDS);
  });
});

describe("ps parsing", () => {
  it("reads TIME as nanoseconds", () => {
    expect(parseCpuTime("0:01.23")).toBe(1230000000);
    expect(parseCpuTime("1:02:03.5")).toBe(3723500000000);
    expect(parseCpuTime("2-03:04:05.25")).toBe(183845250000000);
    expect(parseCpuTime("0:00.005")).toBe(5000000);
    expect(parseCpuTime("")).toBeNull();
    expect(parseCpuTime("1:xx")).toBeNull();
  });

  it("reads the process table, commands with spaces included", () => {
    const table = parseProcessTable(
      "  501     1 /sbin/launchd\n 4242   501 /Users/me/Oarlock App Lab.app/Contents/MacOS/oarlock\n bad line\n",
    );
    expect([...table]).toEqual([
      [501, [1, "/sbin/launchd"]],
      [4242, [501, "/Users/me/Oarlock App Lab.app/Contents/MacOS/oarlock"]],
    ]);
  });

  it("maps the pids the host reported to roles and warns about the rest", () => {
    const table = parseProcessTable(
      [
        "4242 1 /Users/me/Oarlock App Lab.app/Contents/MacOS/oarlock",
        "4300 4242 /System/Library/Frameworks/WebKit.framework/XPCServices/com.apple.WebKit.WebContent",
        "4301 4242 com.apple.WebKit.GPU",
        "4302 4242 com.apple.WebKit.Networking",
        "4303 1 com.apple.WebKit.WebContent",
      ].join("\n"),
    );
    const native = {
      hostPid: 4242,
      webContentPid: 4300,
      gpuPid: 4301,
      networkingPid: 4302,
      prewarmedPids: [4303],
    };
    const [members, warnings] = membersFrom(native, table);
    expect([...members]).toEqual([
      [4300, "web_content"],
      [4301, "gpu"],
      [4302, "networking"],
      [4303, "web_content_prewarmed"],
    ]);
    expect(warnings).toEqual(["pid 4242 is not the expected host process"]);
    const [app] = membersFrom(native, table, {
      ...ROLE_BY_NAME,
      oarlock: "host",
    });
    expect(app.get(4242)).toBe("host");
    expect(membersFrom({ gpuPid: 0 }, table)[1]).toEqual([
      "host pid not reported",
      "web_content pid not reported",
      "gpu pid not reported",
      "networking pid not reported",
    ]);
    expect(roleOf("x/com.apple.WebKit.WebContent", true)).toBe(
      "web_content_prewarmed",
    );
    expect(roleOf("nope")).toBeNull();
  });
});

describe("vmmap parsing", () => {
  it("reads sizes with Python's rounding", () => {
    expect(
      ["12", "1.5K", "1.25M", "3G", "", "x", "0.0009765625K"].map(vmmapBytes),
    ).toEqual([12, 1536, 1310720, 3221225472, 0, 0, 1]);
  });

  it("reads the region table up to the malloc zones", () => {
    const summary = parseVmmapSummary(
      [
        "Physical footprint:         512.3M",
        "                                VIRTUAL RESIDENT    DIRTY  SWAPPED VOLATILE   NONVOL    EMPTY   REGION ",
        "REGION TYPE                        SIZE     SIZE     SIZE     SIZE     SIZE     SIZE     SIZE    COUNT (non-coalesced) ",
        "owned unmapped (graphics)         123.4M   100.0M   100.0M    12.5M       0K       0K       0K        0 ",
        "Odd half                            0.5K     1.5K     2.5K       3       0K       0K       0K        3 ",
        "MALLOC ZONE                         SIZE       SIZE       SIZE       SIZE      COUNT  ALLOCATED",
        "WebKit Using System Malloc_0x10   200.0M     50.0M     40.0M      1.0M      12345     30.0M     11.0M     27%       9",
      ].join("\n"),
    );
    expect(summary).toEqual({
      physicalFootprint: 537185485,
      regions: {
        "owned unmapped (graphics)": {
          virtual: 129394278,
          resident: 104857600,
          dirty: 104857600,
          swapped: 13107200,
          count: 0,
        },
        "Odd half": {
          virtual: 512,
          resident: 1536,
          dirty: 2560,
          swapped: 3,
          count: 3,
        },
      },
    });
  });
});
