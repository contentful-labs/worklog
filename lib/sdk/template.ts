import type { WorklogConfig } from "./types";

export { fillTemplate } from "../template";

export function buildConfigContext(config: WorklogConfig): Record<string, string> {
  return {
    company_values: config.career.companyValues.join(", "),
    current_level: config.career.currentLevel,
    target_level: config.career.targetLevel,
    vault_path: config.vault,
  };
}
