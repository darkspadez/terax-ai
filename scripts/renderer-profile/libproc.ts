// macOS process accounting through libproc and libSystem (bun:ffi). The libraries are opened on
// first use, so importing this module costs nothing (and fails nothing) on other platforms.

import { dlopen } from "bun:ffi";

// struct rusage_info_v4 / rusage_info_v6 (<sys/resource.h>): `uint8_t ri_uuid[16]`, then the
// uint64_t fields of V4_FIELDS (v6: V6_FIELDS, then `uint64_t ri_reserved[9]`) in that order with no
// padding, so field i is at byte offset 16 + 8 * i. The fields the labs read:
//   ri_user_time 16, ri_system_time 24, ri_pkg_idle_wkups 32, ri_interrupt_wkups 40,
//   ri_resident_size 64, ri_phys_footprint 72, ri_proc_start_abstime 80,
//   ri_diskio_bytesread 144, ri_diskio_byteswritten 152, ri_logical_writes 232,
//   ri_lifetime_max_phys_footprint 240, ri_instructions 248, ri_cycles 256,
//   ri_billed_energy 264, ri_serviced_energy 272, ri_runnable_time 288 (v4 ends at 296);
//   ri_user_ptime 304, ri_system_ptime 312, ri_energy_nj 336, ri_penergy_nj 344,
//   ri_reserved 392 (v6 ends at 464).
export const V4_FIELDS = [
  "ri_user_time",
  "ri_system_time",
  "ri_pkg_idle_wkups",
  "ri_interrupt_wkups",
  "ri_pageins",
  "ri_wired_size",
  "ri_resident_size",
  "ri_phys_footprint",
  "ri_proc_start_abstime",
  "ri_proc_exit_abstime",
  "ri_child_user_time",
  "ri_child_system_time",
  "ri_child_pkg_idle_wkups",
  "ri_child_interrupt_wkups",
  "ri_child_pageins",
  "ri_child_elapsed_abstime",
  "ri_diskio_bytesread",
  "ri_diskio_byteswritten",
  "ri_cpu_time_qos_default",
  "ri_cpu_time_qos_maintenance",
  "ri_cpu_time_qos_background",
  "ri_cpu_time_qos_utility",
  "ri_cpu_time_qos_legacy",
  "ri_cpu_time_qos_user_initiated",
  "ri_cpu_time_qos_user_interactive",
  "ri_billed_system_time",
  "ri_serviced_system_time",
  "ri_logical_writes",
  "ri_lifetime_max_phys_footprint",
  "ri_instructions",
  "ri_cycles",
  "ri_billed_energy",
  "ri_serviced_energy",
  "ri_interval_max_phys_footprint",
  "ri_runnable_time",
] as const;
export const V6_FIELDS = [
  ...V4_FIELDS,
  "ri_flags",
  "ri_user_ptime",
  "ri_system_ptime",
  "ri_pinstructions",
  "ri_pcycles",
  "ri_energy_nj",
  "ri_penergy_nj",
  "ri_secure_time_in_system",
  "ri_secure_ptime_in_system",
  "ri_neural_footprint",
  "ri_lifetime_max_neural_footprint",
  "ri_interval_max_neural_footprint",
] as const;

const UUID_BYTES = 16;
const RESERVED_V6 = 9;
export const STRUCT_SIZE = {
  4: UUID_BYTES + 8 * V4_FIELDS.length,
  6: UUID_BYTES + 8 * (V6_FIELDS.length + RESERVED_V6),
} as const;

export type RusageField = (typeof V6_FIELDS)[number];

const LOCK_EX = 2;
const LOCK_NB = 4;

let libraries:
  | {
      proc_pid_rusage(pid: number, flavor: number, buffer: Uint8Array): number;
      mach_timebase_info(info: Uint32Array): number;
      flock(fd: number, operation: number): number;
    }
  | undefined;

function native() {
  if (libraries) return libraries;
  const libproc = dlopen("/usr/lib/libproc.dylib", {
    proc_pid_rusage: { args: ["i32", "i32", "ptr"], returns: "i32" },
  });
  const libsystem = dlopen("/usr/lib/libSystem.B.dylib", {
    mach_timebase_info: { args: ["ptr"], returns: "i32" },
    flock: { args: ["i32", "i32"], returns: "i32" },
  });
  libraries = {
    proc_pid_rusage: (pid, flavor, buffer) =>
      libproc.symbols.proc_pid_rusage(pid, flavor, buffer) as number,
    mach_timebase_info: (info) =>
      libsystem.symbols.mach_timebase_info(info) as number,
    flock: (fd, operation) => libsystem.symbols.flock(fd, operation) as number,
  };
  return libraries;
}

/** `mach_timebase_info`: mach absolute time units (what rusage reports) to nanoseconds. */
export function machTimebase(): { numer: number; denom: number } {
  // struct mach_timebase_info { uint32_t numer; uint32_t denom; }
  const info = new Uint32Array(2);
  native().mach_timebase_info(info);
  return { numer: info[0], denom: info[1] };
}

/**
 * `proc_pid_rusage(pid, flavor)`: the struct's uint64 fields by name, or undefined when the call
 * fails (the process is gone, belongs to another user, or the flavor is unsupported).
 */
export function procPidRusage(
  pid: number,
  flavor: 4 | 6,
): Map<RusageField, bigint> | undefined {
  const buffer = new Uint8Array(STRUCT_SIZE[flavor]);
  if (native().proc_pid_rusage(pid, flavor, buffer) !== 0) return undefined;
  const view = new DataView(buffer.buffer);
  const fields = flavor === 6 ? V6_FIELDS : V4_FIELDS;
  return new Map(
    fields.map((name, index) => [
      name,
      view.getBigUint64(UUID_BYTES + 8 * index, true),
    ]),
  );
}

/** `flock(fd, LOCK_EX | LOCK_NB)`: true when this process now holds the exclusive lock. */
export function lockExclusive(fd: number): boolean {
  return native().flock(fd, LOCK_EX | LOCK_NB) === 0;
}
