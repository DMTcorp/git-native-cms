---
title: SEO, localization and search
description: Inheritance, locale/market fallback, redirects, XLIFF, hreflang and usage graphs.
---

Project defaults, page-type defaults and document overrides form the SEO inheritance chain.
Release generation emits canonical metadata, Open Graph values, sitemap entries and `hreflang`
alternates. A slug change preserves the old localized path in the redirects artifact.

Locales use explicit BCP 47 identifiers. The reference project uses `en-US` as source and `pl-PL`
as the first demonstration locale. Locale and market lookup follows the configured fallback chain;
missing required translations are reported before publication.

Editors can export a document to XLIFF, import the translated units with the expected source
revision, or create an asynchronous job through a translation provider port. Imported strings
remain part of the same Change and carry translation status.

The release builder emits a content index, reference/asset usage graph and search index. The
editor uses them for global search, broken-reference checks and **Find usages**. Index generation
and queries are deterministic and included in the performance budget against 10,000 documents.
