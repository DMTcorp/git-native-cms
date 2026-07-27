# ADR-0002: Release identity is content-derived

Status: accepted

A release identifier is derived from a SHA-256 digest of its canonical input manifest. Building
the same Git SHA, registry lock and configuration therefore produces the same release identifier
and checksums. Environment pointers are the only mutable release objects.
