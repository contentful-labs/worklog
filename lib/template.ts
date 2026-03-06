import { requireConfig } from "./config";
import { buildConfigContext as sdkBuildConfigContext } from "./sdk/template";

export function fillTemplate(
  template: string,
  context: Record<string, string>
): string {
  let result = template;
  for (const [key, value] of Object.entries(context))
    result = result.replaceAll(`{{${key}}}`, value);
  return result;
}

export function buildConfigContext(): Record<string, string> {
  return sdkBuildConfigContext(requireConfig());
}
