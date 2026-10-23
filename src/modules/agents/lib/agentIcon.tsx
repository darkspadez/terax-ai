import {
  AiBrowserIcon,
  ChatGptIcon,
  ClaudeIcon,
  CodeIcon,
  GoogleGeminiIcon,
  GoogleIcon,
  Grok02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";

// Pi mark, from github.com/earendil-works pi-website logo.svg (MIT).
function PiIcon({ size, className }: { size: number; className?: string }) {
  return (
    <svg
      viewBox="0 0 800 800"
      width={size}
      height={size}
      className={className}
      aria-hidden="true"
    >
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z"
      />
      <path fill="currentColor" d="M517.36 400H634.72V634.72H517.36Z" />
    </svg>
  );
}

// Brand marks for the agents Oarlock knows, by exact id. A name reported by a
// terminal is untrusted text: anything else, including names that merely
// contain a known one, gets the generic mark.
const BRAND_ICONS: ReadonlyMap<string, IconSvgElement> = new Map([
  ["claude", ClaudeIcon],
  ["codex", ChatGptIcon],
  ["gemini", GoogleGeminiIcon],
  ["antigravity", GoogleIcon],
  ["opencode", CodeIcon],
  ["grok", Grok02Icon],
]);

/** The mark an agent is drawn with: Pi's and Oarlock's own, or an icon. */
export function agentMark(agent: string): "pi" | "oarlock" | IconSvgElement {
  const id = agent.toLowerCase();
  if (id === "pi" || id === "oarlock") return id;
  return BRAND_ICONS.get(id) ?? AiBrowserIcon;
}

export function AgentIcon({
  agent,
  size = 15,
  className,
}: {
  agent: string;
  size?: number;
  className?: string;
}) {
  const mark = agentMark(agent);
  if (mark === "pi") {
    return <PiIcon size={size} className={className} />;
  }
  if (mark === "oarlock") {
    return (
      <img
        src="/logo.png"
        alt=""
        width={size}
        height={size}
        className={className}
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <HugeiconsIcon
      icon={mark}
      size={size}
      strokeWidth={1.75}
      className={className}
    />
  );
}
