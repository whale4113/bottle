import { Streamdown } from "streamdown";

export default function MarkdownAnswer({
  text,
  streaming,
  generating,
}: {
  text: string;
  streaming: boolean;
  generating: boolean;
}) {
  return (
    <Streamdown
      className="bottle-answer-text min-w-0"
      mode={streaming ? "streaming" : "static"}
      isAnimating={generating && streaming}
      caret="block"
      controls={false}
      disallowedElements={["img"]}
    >
      {text}
    </Streamdown>
  );
}
