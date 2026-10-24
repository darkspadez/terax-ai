import { invoke } from "@tauri-apps/api/core";

export type PingState = {
  status: "idle" | "testing" | "ok" | "fail";
  /** Why the server could not be reached (DNS, refused, TLS certificate). */
  error?: string;
};

/** The endpoint card's Test: any HTTP answer means the server is reachable. */
export async function pingEndpoint(baseUrl: string): Promise<PingState> {
  try {
    const status = await invoke<number>("lm_ping", { baseUrl });
    return { status: status > 0 ? "ok" : "fail" };
  } catch (error) {
    return { status: "fail", error: String(error) };
  }
}
