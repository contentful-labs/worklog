import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkFrontmatter from "remark-frontmatter";
import remarkDocx from "remark-docx";

export async function markdownToDocx(md: string): Promise<Buffer> {
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkFrontmatter)
    .use(remarkDocx);
  const doc = await processor.process(md);
  return Buffer.from((await doc.result) as ArrayBuffer);
}
