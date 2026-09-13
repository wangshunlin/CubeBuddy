#!/usr/bin/env node

import SwaggerParser from '@apidevtools/swagger-parser';
import YAML from 'yaml';

const target = process.argv[2] || process.env.OPENAPI_VALIDATE_TARGET || 'server/openapi/openapi.yaml';

try {
  const source = /^https?:\/\//i.test(target)
    ? await fetch(target).then(async (response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status} from ${target}`);
      const text = await response.text();
      return YAML.parse(text);
    })
    : target;
  const api = await SwaggerParser.validate(source);
  const operations = Object.values(api.paths || {}).flatMap((pathItem) => Object.entries(pathItem || {})
    .filter(([method]) => ['get', 'post', 'put', 'delete', 'patch', 'options', 'head'].includes(method))
    .map(([, operation]) => operation.operationId)
    .filter(Boolean));
  console.log(`OpenAPI valid: ${target}`);
  console.log(`Version: ${api.openapi}; paths: ${Object.keys(api.paths || {}).length}; operations: ${operations.length}`);
} catch (error) {
  console.error(`OpenAPI invalid: ${target}`);
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
}
