// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// Dipisah dari pemakainya supaya react-markdown dan remark-gfm bisa dimuat
// belakangan lewat ./lazy, bukan ikut bundel awal.
const MarkdownBody: React.FC<{ children: string }> = ({ children }) => (
  <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
);

export default MarkdownBody;
