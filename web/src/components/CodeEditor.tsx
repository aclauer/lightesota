import CodeMirror from "@uiw/react-codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { oneDark } from "@codemirror/theme-one-dark";

export default function CodeEditor({ value, dark, onChange }: { value: string; dark: boolean; onChange: (v: string) => void }) {
  return (
    <CodeMirror value={value} height="100%" theme={dark ? oneDark : "light"} extensions={[javascript()]} onChange={onChange}
      basicSetup={{ lineNumbers: true, foldGutter: true, autocompletion: true, bracketMatching: true, highlightActiveLine: true }} />
  );
}
