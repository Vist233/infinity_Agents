"use client";

import React, { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import { getApiBase } from "@/lib/runtime-config";

interface MarkdownRendererProps {
    content: string;
    sessionId?: string | null;
}

const MarkdownRenderer = memo(function MarkdownRenderer({
    content,
    sessionId,
}: MarkdownRendererProps) {
    const apiOrigin = getApiBase();

    return (
        <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            urlTransform={(url) => {
                // Convert img:// protocol to backend HTTP URL before react-markdown's sanitizer strips it
                if (url.startsWith("img://")) {
                    const filename = url.slice(6);
                    if (sessionId) {
                        return `${apiOrigin}/api/sessions/${encodeURIComponent(sessionId)}/files/${encodeURIComponent(filename)}`;
                    }
                    return `${apiOrigin}/api/files/${encodeURIComponent(filename)}`;
                }
                return url;
            }}
            components={{
                // Code blocks with syntax highlighting
                code({ className, children, ...props }) {
                    const match = /language-(\w+)/.exec(className || "");
                    const codeString = String(children).replace(/\n$/, "");

                    if (match) {
                        return (
                            <div className="md-code-block">
                                <div className="md-code-header">
                                    <span>{match[1]}</span>
                                    <button
                                        className="md-copy-btn"
                                        onClick={() => navigator.clipboard.writeText(codeString)}
                                    >
                                        Copy
                                    </button>
                                </div>
                                <SyntaxHighlighter
                                    style={oneDark}
                                    language={match[1]}
                                    PreTag="div"
                                    customStyle={{
                                        margin: 0,
                                        borderRadius: "0 0 8px 8px",
                                        fontSize: "13px",
                                    }}
                                >
                                    {codeString}
                                </SyntaxHighlighter>
                            </div>
                        );
                    }

                    // Inline code
                    return (
                        <code className="md-inline-code" {...props}>
                            {children}
                        </code>
                    );
                },

                // Tables
                table({ children }) {
                    return (
                        <div className="md-table-wrapper">
                            <table className="md-table">{children}</table>
                        </div>
                    );
                },

                // Links open in new tab
                a({ href, children }) {
                    return (
                        <a
                            href={href}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="md-link"
                        >
                            {children}
                        </a>
                    );
                },

                // Blockquotes
                blockquote({ children }) {
                    return <blockquote className="md-blockquote">{children}</blockquote>;
                },

                // Lists
                ul({ children }) {
                    return <ul className="md-ul">{children}</ul>;
                },
                ol({ children }) {
                    return <ol className="md-ol">{children}</ol>;
                },

                // Headings
                h1({ children }) {
                    return <h1 className="md-h1">{children}</h1>;
                },
                h2({ children }) {
                    return <h2 className="md-h2">{children}</h2>;
                },
                h3({ children }) {
                    return <h3 className="md-h3">{children}</h3>;
                },

                // Horizontal rule
                hr() {
                    return <hr className="md-hr" />;
                },

                // Images — src is already transformed by urlTransform above
                img({ src, alt }) {
                    if (!src) return null;

                    return (
                        <span className="md-image-wrapper">
                            <img
                                src={src}
                                alt={alt || ""}
                                className="md-image"
                                loading="lazy"
                                onError={(e) => {
                                    const wrapper = (e.target as HTMLImageElement).parentElement;
                                    if (wrapper) wrapper.style.display = "none";
                                }}
                            />
                            {alt && <span className="md-image-caption">{alt}</span>}
                        </span>
                    );
                },

                // Paragraphs — use <div> if children contain images to avoid <div>-in-<p> error
                p({ children, ...props }) {
                    const childArray = React.Children.toArray(children);
                    const hasImage = childArray.some(
                        (child) =>
                            React.isValidElement(child) &&
                            (child.type === "img" || child.type === "span" &&
                                (child.props as Record<string, unknown>)?.className === "md-image-wrapper")
                    );
                    if (hasImage) {
                        return <div className="md-p" {...props}>{children}</div>;
                    }
                    return <p className="md-p" {...props}>{children}</p>;
                },
            }}
        >
            {content}
        </ReactMarkdown>
    );
});

export default MarkdownRenderer;
