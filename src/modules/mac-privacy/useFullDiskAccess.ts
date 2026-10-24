import { IS_MAC } from "@/lib/platform";
import { useEffect, useState } from "react";
import type { Access } from "./lib/areas";
import { fullDiskAccess } from "./native";

/**
 * Full Disk Access, checked on mount and again whenever the window gains
 * focus, since the user may just have changed it in System Settings. Null
 * until the first answer, and always off macOS.
 */
export function useFullDiskAccess(): Access | null {
  const [access, setAccess] = useState<Access | null>(null);

  useEffect(() => {
    if (!IS_MAC) return;
    let alive = true;
    let latest = 0;
    const check = () => {
      const request = ++latest;
      const settle = (next: Access) => {
        if (alive && request === latest) setAccess(next);
      };
      fullDiskAccess().then(settle, () => settle("unknown"));
    };
    check();
    window.addEventListener("focus", check);
    return () => {
      alive = false;
      window.removeEventListener("focus", check);
    };
  }, []);

  return access;
}
