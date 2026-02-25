import { requireConfig } from "./config";

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
  const config = requireConfig();
  return {
    company_values: config.career.companyValues.join(", "),
    current_level: config.career.currentLevel,
    target_level: config.career.targetLevel,
  };
}
