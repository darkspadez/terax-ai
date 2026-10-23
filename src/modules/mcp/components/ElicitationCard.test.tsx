import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { elicitationFields } from "../lib/elicitation";
import type { PendingElicitation } from "../lib/requests";
import { ElicitationCard } from "./ElicitationCard";

function render(message: string): string {
  const form = elicitationFields({
    type: "object",
    properties: {
      email: { type: "string", format: "email", title: "Email" },
      when: { type: "string", format: "date-time" },
      seats: { type: "integer", minimum: 1, maximum: 4 },
      color: {
        type: "string",
        oneOf: [
          { const: "r", title: "Red" },
          { const: "g", title: "Green" },
        ],
      },
      extras: {
        type: "array",
        items: { type: "string", enum: ["wifi", "tv"] },
      },
      agree: { type: "boolean", title: "I agree" },
    },
    required: ["email"],
  });
  if ("unsupported" in form) throw new Error(form.unsupported);
  const request: PendingElicitation = {
    id: "r1",
    serverId: "s1",
    serverName: "Booking",
    message,
    fields: form.fields,
    signal: new AbortController().signal,
    answer: () => {},
  };
  return renderToStaticMarkup(<ElicitationCard request={request} />);
}

describe("ElicitationCard", () => {
  it("says which server asks, shows its message as the server's, and warns", () => {
    const html = render("Book a <b>room</b>");
    expect(html).toContain("Booking asks for information");
    expect(html).toContain("The MCP server Booking writes:");
    expect(html).toContain("Book a &lt;b&gt;room&lt;/b&gt;");
    expect(html).toContain(
      "never enter passwords, keys or payment details here",
    );
    expect(html).toContain("Decline");
    expect(html).toContain("Submit");
    expect(html).toContain('aria-label="Dismiss"');
  });

  it("builds an input for each kind of field", () => {
    const html = render("");
    expect(html).not.toContain("writes:");
    expect(html).toContain('type="email"');
    expect(html).toContain('type="datetime-local"');
    expect(html).toContain('inputMode="numeric"');
    expect(html).toContain("A whole number from 1 to 4.");
    expect(html).toContain('<option value="r">Red</option>');
    expect(html).toContain(">wifi<");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("I agree");
    expect(html).toContain("(required)");
  });
});
