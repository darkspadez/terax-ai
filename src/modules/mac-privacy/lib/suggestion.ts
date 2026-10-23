import type { Access } from "./areas";

/**
 * Whether the launch notice suggests Full Disk Access: only when Oarlock is
 * known not to have it, never when it has it or may have it.
 */
export function shouldSuggestFullDiskAccess(fullDiskAccess: Access): boolean {
  return fullDiskAccess === "denied";
}
