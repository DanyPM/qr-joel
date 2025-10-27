// @ts-check

import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintPluginPrettierRecommended from "eslint-plugin-prettier/recommended";
import prettierConfig from "eslint-config-prettier";

// eslint-disable-next-line @typescript-eslint/no-deprecated -- config helper keeps shared setup concise
export default tseslint.config(
  eslint.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["*.js", "*.html"],
        },
      },
    },
  },
  prettierConfig,
  eslintPluginPrettierRecommended,
);
