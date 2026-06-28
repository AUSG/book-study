# Weighted Trie Demo

FastAPI가 가중치 트라이를 만들고 React가 그 트라이를 한 번 받아 브라우저 메모리에서 자동완성을 수행하는 최소 데모입니다.

## 실행

터미널 1:

```bash
cd weighted-trie-demo/backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

터미널 2:

```bash
cd weighted-trie-demo/frontend
npm install
npm run dev
```

브라우저에서 `http://127.0.0.1:5173`을 엽니다.

## 핵심 흐름

1. 서버는 `WORDS` 목록의 각 단어를 한 글자씩 트라이에 삽입합니다.
2. 각 prefix 노드의 `top` 배열에는 그 prefix에서 가장 높은 가중치의 후보 5개를 미리 저장합니다.
3. 클라이언트는 `/api/trie`를 앱 시작 시 한 번만 가져옵니다.
4. 사용자가 입력할 때 React는 네트워크 요청 없이 `children[char]`를 따라 내려가고, 도착 노드의 `top`을 화면에 보여줍니다.

예를 들어 `ap`를 입력하면 `root -> a -> p` 노드까지 이동하고, 그 노드에 저장된 `apple`, `application`, `app` 같은 후보가 가중치 순서로 반환됩니다.
