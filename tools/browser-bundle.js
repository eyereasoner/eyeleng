#!/usr/bin/env node
'use strict';

// Kept as a compatibility entry point. The canonical builder now handles
// the CLI, dependency-aware browser bundle, ES module wrapper, and playground.
require('./bundle.js');
