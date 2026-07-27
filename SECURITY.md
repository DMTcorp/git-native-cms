# Security policy

Report vulnerabilities privately to the maintainers. Do not open a public issue containing an
exploit, credential or affected customer content.

The CMS keeps OAuth and installation tokens server-side, validates mutation CSRF tokens, verifies
GitHub webhook signatures and treats preview URLs and presigned upload URLs as bearer credentials.
