import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { WeightedTrieDemoView } from "./WeightedTrieDemoView";
import "./styles.css";

export type WeightedWord = {
  word: string;
  weight: number;
  description: string;
};

export type TrieNode = {
  top: WeightedWord[];
  terminal: WeightedWord | null;
  children: Record<string, TrieNode>;
};

type TrieResponse = {
  version: string;
  maxSuggestionsPerNode: number;
  node: TrieNode;
};

type TrieSearchResult = {
  node: TrieNode | null;
  visited: string[];
};

function findNode(root: TrieNode, prefix: string): TrieSearchResult {
  let current: TrieNode | undefined = root;
  const visited = ["root"];

  // prefix의 문자를 하나씩 따라가며 트라이 아래로 내려간다.
  for (const char of prefix.toLowerCase()) {
    current = current.children[char];
    visited.push(char);

    // 중간에 자식 노드가 없으면 해당 prefix로 시작하는 단어가 없다는 뜻이다.
    if (!current) {
      return { node: null, visited };
    }
  }

  // 도착한 노드의 top 배열이 현재 prefix의 추천어 목록이다.
  return { node: current, visited };
}

function App() {
  // 서버에서 받은 트라이 JSON을 브라우저 메모리에 보관한다.
  const [trie, setTrie] = useState<TrieResponse | null>(null);
  const [words, setWords] = useState<WeightedWord[]>([]);

  // 사용자가 입력한 prefix다. 빈 문자열이면 root 노드를 조회한다.
  const [query, setQuery] = useState("");
  const [loadCount, setLoadCount] = useState(0);

  useEffect(() => {
    async function loadInitialData() {
      // 앱이 처음 열릴 때만 서버에서 트라이를 다운로드한다.
      // 이후 자동완성 검색은 네트워크 요청 없이 클라이언트에서 처리한다.
      const [trieResponse, wordsResponse] = await Promise.all([
        fetch(`http://127.0.0.1:8000/api/trie`),
        fetch(`http://127.0.0.1:8000/api/words`),
      ]);

      setTrie(await trieResponse.json());
      setWords(await wordsResponse.json());
      setLoadCount((current) => current + 2);
    }

    loadInitialData();
  }, []);

  let result: TrieSearchResult = {
    node: null,
    visited: [],
  };

  if (trie !== null) {
    result = findNode(trie.node, query.trim());
  }

  // 현재 prefix 노드가 있으면 서버가 미리 계산해둔 top 후보를 그대로 사용한다.
  let suggestions: WeightedWord[] = [];
  if (result.node !== null) {
    suggestions = result.node.top;
  }

  let maxSuggestionsPerNode: number | "-" = "-";
  if (trie !== null) {
    maxSuggestionsPerNode = trie.maxSuggestionsPerNode;
  }

  const viewProps = {
    query,
    wordCount: words.length,
    maxSuggestionsPerNode,
    initialNetworkCalls: loadCount,
    suggestions,
    visited: result.visited,
    currentNode: result.node,
    onQueryChange: setQuery,
  };

  return <WeightedTrieDemoView {...viewProps} />;
}

createRoot(document.getElementById("root")!).render(<App />);
