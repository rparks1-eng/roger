import { pythonDomain } from './python-domain.mjs';
export async function retrieveSources(value, { signal } = {}) {
  return pythonDomain('retrieval', value, { signal });
}
