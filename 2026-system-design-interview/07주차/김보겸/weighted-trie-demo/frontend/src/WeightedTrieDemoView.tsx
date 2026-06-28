import { Database, DownloadCloud, Network, Search } from "lucide-react";
import type { TrieNode, WeightedWord } from "./main";

type WeightedTrieDemoViewProps = {
  query: string;
  wordCount: number;
  maxSuggestionsPerNode: number | "-";
  initialNetworkCalls: number;
  suggestions: WeightedWord[];
  visited: string[];
  currentNode: TrieNode | null;
  onQueryChange: (value: string) => void;
};

export function WeightedTrieDemoView({
  query,
  wordCount,
  maxSuggestionsPerNode,
  initialNetworkCalls,
  suggestions,
  visited,
  currentNode,
  onQueryChange,
}: WeightedTrieDemoViewProps) {
  // 이 파일은 화면 표시만 담당한다. 트라이 다운로드와 탐색 로직은 main.tsx에 둔다.
  return (
    <main className="page-shell">
      <Hero
        wordCount={wordCount}
        maxSuggestionsPerNode={maxSuggestionsPerNode}
        initialNetworkCalls={initialNetworkCalls}
      />

      <section className="workspace">
        <SearchPanel
          query={query}
          suggestions={suggestions}
          onQueryChange={onQueryChange}
        />
        <FlowPanel visited={visited} />
      </section>

      <JsonView currentNode={currentNode} />
    </main>
  );
}

function Hero({
  wordCount,
  maxSuggestionsPerNode,
  initialNetworkCalls,
}: Pick<
  WeightedTrieDemoViewProps,
  "wordCount" | "maxSuggestionsPerNode" | "initialNetworkCalls"
>) {
  return (
    <section className="hero">
      <div>
        <p className="eyebrow">FastAPI + React</p>
        <h1>가중치 트라이 자동완성 데모</h1>
        <p className="summary">
          서버는 단어 목록으로 가중치 트라이 JSON을 만들고, 브라우저는 그
          트라이를 한 번 받은 뒤 입력할 때마다 로컬 메모리에서 prefix 노드를
          찾아 추천어를 꺼냅니다.
        </p>
      </div>
      <div className="metrics" aria-label="demo metrics">
        <div>
          <span>{wordCount}</span>
          <p>weighted words</p>
        </div>
        <div>
          <span>{maxSuggestionsPerNode}</span>
          <p>top list per node</p>
        </div>
        <div>
          <span>{initialNetworkCalls}</span>
          <p>initial network calls</p>
        </div>
      </div>
    </section>
  );
}

function SearchPanel({
  query,
  suggestions,
  onQueryChange,
}: Pick<WeightedTrieDemoViewProps, "query" | "suggestions" | "onQueryChange">) {
  return (
    <div className="panel search-panel">
      <div className="panel-title">
        <Search size={18} aria-hidden="true" />
        <h2>클라이언트 검색</h2>
      </div>
      <label htmlFor="query">prefix</label>
      <input
        id="query"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        placeholder="예: ap, ban, ca"
        autoComplete="off"
      />
      <p className="hint">
        입력을 바꿔도 추가 API 호출은 없습니다. `top` 배열을 가진 노드를
        브라우저에서 바로 찾아옵니다.
      </p>

      <div className="suggestions">
        {suggestions.length > 0 ? (
          suggestions.map((item) => (
            <div className="suggestion" key={item.word}>
              <div>
                <strong>{item.word}</strong>
                <p>{item.description}</p>
              </div>
              <span>{item.weight}</span>
            </div>
          ))
        ) : (
          <div className="empty">일치하는 prefix 노드가 없습니다.</div>
        )}
      </div>
    </div>
  );
}

function FlowPanel({ visited }: Pick<WeightedTrieDemoViewProps, "visited">) {
  return (
    <div className="panel flow-panel">
      <div className="panel-title">
        <Network size={18} aria-hidden="true" />
        <h2>동작 흐름</h2>
      </div>
      <ol className="flow">
        <li>
          <DownloadCloud size={17} aria-hidden="true" />
          <span>앱 시작 시 `/api/trie`를 한 번 다운로드</span>
        </li>
        <li>
          <Database size={17} aria-hidden="true" />
          <span>JSON 트라이를 React state에 보관</span>
        </li>
        <li>
          <Search size={17} aria-hidden="true" />
          <span>입력 prefix의 문자들을 따라 노드 이동</span>
        </li>
      </ol>

      <div className="trace">
        <h3>현재 순회 경로</h3>
        <div className="path">
          {visited.map((step, index) => (
            <span key={`${step}-${index}`}>{step}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

function JsonView({
  currentNode,
}: Pick<WeightedTrieDemoViewProps, "currentNode">) {
  return (
    <section className="json-view">
      <h2>현재 prefix 노드의 JSON</h2>
      <pre>
        {JSON.stringify(
          currentNode
            ? {
                top: currentNode.top,
                terminal: currentNode.terminal,
                childKeys: Object.keys(currentNode.children),
              }
            : null,
          null,
          2,
        )}
      </pre>
    </section>
  );
}
