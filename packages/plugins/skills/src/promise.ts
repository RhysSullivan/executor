import { skillsPlugin as skillsPluginEffect } from "./index";

export type { Skill, SkillsPluginOptions } from "./index";
export { toStaticSkill } from "./index";

export const skillsPlugin = (options?: {
  readonly skills?: readonly import("./index").Skill[];
}) => skillsPluginEffect(options);
