import { describe, it, expect } from "vitest";
import { postProcess } from "../ai";

describe("postProcess", () => {
  it("returns plain text as-is", () => {
    expect(postProcess("Hello world")).toBe("Hello world");
  });

  it("strips preamble before frontmatter", () => {
    const input = "Here is the document:\n---\ntitle: My Doc\n---\nContent";
    expect(postProcess(input)).toBe("---\ntitle: My Doc\n---\nContent");
  });

  it("strips preamble before heading", () => {
    const input = "Sure, here you go:\n# Weekly Summary\nDid stuff";
    expect(postProcess(input)).toBe("# Weekly Summary\nDid stuff");
  });

  it("strips preamble before code block", () => {
    const input = "Here is the markdown:\n```markdown\n# Doc\nContent\n```";
    expect(postProcess(input)).toBe("# Doc\nContent");
  });

  it("unwraps code block wrapping when no preamble markers inside", () => {
    const input = "```markdown\nSome content here\n```";
    expect(postProcess(input)).toBe("Some content here");
  });

  it("keeps frontmatter that is already at the start", () => {
    const input = "---\ntags:\n  - areas/work\n---\n# Brag Book\nBody";
    expect(postProcess(input)).toBe(input);
  });

  it("picks earliest preamble marker", () => {
    const input = "Preamble text\n# Heading\nBody\n---\nFooter";
    expect(postProcess(input)).toBe("# Heading\nBody\n---\nFooter");
  });
});
