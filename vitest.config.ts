import { defineConfig as define_config } from 'vitest/config';

export default define_config({
  test: {
    coverage: {
      enabled: false,
    },
    environment: 'node',
  },
});
