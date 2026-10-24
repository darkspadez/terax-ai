import { describe, expect, it } from "vitest";
import {
  type ElicitField,
  elicitationFields,
  initialValues,
  validateElicitation,
} from "./elicitation";

function fields(properties: Record<string, unknown>, required: string[] = []) {
  const out = elicitationFields({ type: "object", properties, required });
  if ("unsupported" in out) throw new Error(out.unsupported);
  return out.fields;
}

describe("elicitationFields", () => {
  it("builds every primitive field of the spec", () => {
    expect(
      fields(
        {
          name: { type: "string", title: "Name", minLength: 2, maxLength: 5 },
          email: { type: "string", format: "email", default: "a@b.co" },
          age: { type: "integer", minimum: 18, maximum: 99, default: 30 },
          ratio: { type: "number" },
          ok: { type: "boolean", default: true, description: "Agree?" },
          color: {
            type: "string",
            enum: ["r", "g"],
            enumNames: ["Red", "Green"],
          },
          size: {
            type: "string",
            oneOf: [
              { const: "s", title: "Small" },
              { const: "l", title: "Large" },
            ],
            default: "l",
          },
          tags: {
            type: "array",
            items: { type: "string", enum: ["a", "b", "c"] },
            minItems: 1,
            maxItems: 2,
            default: ["a", "zzz"],
          },
          titled: {
            type: "array",
            items: { anyOf: [{ const: "x", title: "Ex" }] },
          },
        },
        ["name", "color"],
      ),
    ).toEqual([
      {
        name: "name",
        label: "Name",
        description: undefined,
        required: true,
        kind: "string",
        minLength: 2,
        maxLength: 5,
        format: undefined,
        default: undefined,
      },
      {
        name: "email",
        label: "email",
        description: undefined,
        required: false,
        kind: "string",
        minLength: undefined,
        maxLength: undefined,
        format: "email",
        default: "a@b.co",
      },
      {
        name: "age",
        label: "age",
        description: undefined,
        required: false,
        kind: "number",
        integer: true,
        minimum: 18,
        maximum: 99,
        default: 30,
      },
      {
        name: "ratio",
        label: "ratio",
        description: undefined,
        required: false,
        kind: "number",
        integer: false,
        minimum: undefined,
        maximum: undefined,
        default: undefined,
      },
      {
        name: "ok",
        label: "ok",
        description: "Agree?",
        required: false,
        kind: "boolean",
        default: true,
      },
      {
        name: "color",
        label: "color",
        description: undefined,
        required: true,
        kind: "choice",
        options: [
          { value: "r", label: "Red" },
          { value: "g", label: "Green" },
        ],
        default: undefined,
      },
      {
        name: "size",
        label: "size",
        description: undefined,
        required: false,
        kind: "choice",
        options: [
          { value: "s", label: "Small" },
          { value: "l", label: "Large" },
        ],
        default: "l",
      },
      {
        name: "tags",
        label: "tags",
        description: undefined,
        required: false,
        kind: "multi",
        options: [
          { value: "a", label: "a" },
          { value: "b", label: "b" },
          { value: "c", label: "c" },
        ],
        minItems: 1,
        maxItems: 2,
        default: ["a"],
      },
      {
        name: "titled",
        label: "titled",
        description: undefined,
        required: false,
        kind: "multi",
        options: [{ value: "x", label: "Ex" }],
        minItems: undefined,
        maxItems: undefined,
        default: undefined,
      },
    ]);
  });

  it("declines anything but flat primitive fields, with the reason", () => {
    expect(elicitationFields({ type: "array" })).toEqual({
      unsupported: "The requested schema is not an object.",
    });
    for (const property of [
      { type: "object", properties: {} },
      { type: "array", items: { type: "number" } },
      { type: "string", format: "color" },
      { type: "string", enum: [] },
      { type: "string", enum: ["a", "a"] },
      { type: "null" },
      "string",
    ]) {
      const out = elicitationFields({
        type: "object",
        properties: { thing: property },
      });
      expect(out).toHaveProperty("unsupported");
    }
    expect(
      elicitationFields({
        type: "object",
        properties: { nested: { type: "object", title: "Address" } },
      }),
    ).toEqual({
      unsupported:
        'The field "Address" asks for a kind of value Oarlock\'s forms do not support.',
    });
  });

  it("has no field for an empty schema", () => {
    expect(elicitationFields({ type: "object" })).toEqual({ fields: [] });
  });
});

describe("initialValues", () => {
  it("starts from the defaults", () => {
    const f = fields({
      a: { type: "string", default: "x" },
      b: { type: "number", default: 2 },
      c: { type: "boolean" },
      d: { type: "array", items: { type: "string", enum: ["p"] } },
    });
    expect(initialValues(f)).toEqual({ a: "x", b: "2", c: false, d: [] });
  });
});

describe("validateElicitation", () => {
  const form: ElicitField[] = fields(
    {
      name: { type: "string", minLength: 2, maxLength: 4 },
      email: { type: "string", format: "email" },
      site: { type: "string", format: "uri" },
      day: { type: "string", format: "date" },
      count: { type: "integer", minimum: 1, maximum: 3 },
      ratio: { type: "number" },
      ok: { type: "boolean" },
      color: { type: "string", enum: ["r", "g"] },
      tags: {
        type: "array",
        items: { type: "string", enum: ["a", "b", "c"] },
        maxItems: 2,
      },
    },
    ["name", "color", "tags"],
  );

  it("sends typed content and leaves empty optional fields out", () => {
    expect(
      validateElicitation(form, {
        name: "Ann",
        email: " ann@example.com ",
        site: "",
        day: "2024-02-29",
        count: "2",
        ratio: "0.5",
        ok: true,
        color: "g",
        tags: ["c", "a"],
      }),
    ).toEqual({
      errors: {},
      content: {
        name: "Ann",
        email: "ann@example.com",
        day: "2024-02-29",
        count: 2,
        ratio: 0.5,
        ok: true,
        color: "g",
        tags: ["a", "c"],
      },
    });
  });

  it("says what is wrong with each field and sends nothing", () => {
    const out = validateElicitation(form, {
      name: "A",
      email: "nope",
      site: "not a url",
      day: "2023-02-29",
      count: "2.5",
      ratio: "abc",
      ok: false,
      color: "",
      tags: ["a", "b", "c"],
    });
    expect(out.content).toBeNull();
    expect(out.errors).toEqual({
      name: "Enter at least 2 characters.",
      email: "Enter an email address.",
      site: "Enter a full address, such as https://…",
      day: "Enter a date as YYYY-MM-DD.",
      count: "Enter a whole number.",
      ratio: "Enter a number.",
      color: "Choose one.",
      tags: "Choose at most 2.",
    });
  });

  it("checks bounds, lengths, required choices and unknown options", () => {
    const out = validateElicitation(form, {
      name: "Abcde",
      count: "9",
      color: "blue",
      tags: [],
    });
    expect(out.errors).toEqual({
      name: "Enter at most 4 characters.",
      count: "Enter 3 or less.",
      color: "Choose one of the options.",
      tags: "Choose at least one.",
    });
  });

  it("sends a date-time as RFC 3339", () => {
    const [field] = fields({ at: { type: "string", format: "date-time" } });
    const offset = validateElicitation([field], {
      at: "2025-01-02T03:04:05+02:00",
    });
    expect(offset.content).toEqual({ at: "2025-01-02T03:04:05+02:00" });
    const local = validateElicitation([field], { at: "2025-01-02T03:04" });
    expect(local.content?.at).toMatch(/^2025-01-0[12]T\d{2}:04:00\.000Z$/);
    expect(
      validateElicitation([field], { at: "2025-01-02T25:00" }).errors,
    ).toEqual({
      at: "Enter a date and time.",
    });
  });
});
