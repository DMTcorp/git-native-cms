# ADR-0001: Ports are owned by the application layer

Status: accepted

Application commands define the capability contracts they require. GitHub, storage, session and
framework packages implement those contracts and depend inward. No adapter shape is duplicated
in another package.
