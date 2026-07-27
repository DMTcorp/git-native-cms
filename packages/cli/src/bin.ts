#!/usr/bin/env node
import { runCmsCli } from "./index.js";

process.exitCode = await runCmsCli(process.argv.slice(2));
