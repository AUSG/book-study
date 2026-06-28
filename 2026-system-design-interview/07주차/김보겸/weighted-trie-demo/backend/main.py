from __future__ import annotations

from typing import List

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel


MAX_SUGGESTIONS_PER_NODE = 5


class WeightedWord(BaseModel):
    word: str
    weight: int
    description: str


WORDS = [
    WeightedWord(word="apple", weight=92, description="사과"),
    WeightedWord(word="app", weight=71, description="앱"),
    WeightedWord(word="application", weight=83, description="응용 프로그램"),
    WeightedWord(word="apply", weight=64, description="지원하다/적용하다"),
    WeightedWord(word="apricot", weight=41, description="살구"),
    WeightedWord(word="banana", weight=88, description="바나나"),
    WeightedWord(word="band", weight=49, description="밴드"),
    WeightedWord(word="bank", weight=74, description="은행"),
    WeightedWord(word="bar", weight=38, description="막대/바"),
    WeightedWord(word="cat", weight=68, description="고양이"),
    WeightedWord(word="catalog", weight=53, description="목록"),
    WeightedWord(word="catch", weight=46, description="잡다"),
    WeightedWord(word="dog", weight=57, description="개"),
    WeightedWord(word="door", weight=63, description="문"),
    WeightedWord(word="dorm", weight=31, description="기숙사"),
]


def word_weight(item: WeightedWord) -> int:
    return item.weight


app = FastAPI(title="Weighted Trie Demo")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def build_weighted_trie(words: List[WeightedWord]) -> dict:
    def new_node() -> dict:
        node = {}
        node["top"] = []
        node["terminal"] = None
        node["children"] = {}

        return node

    def remember_best_words(node: dict, item: WeightedWord) -> None:
        top_words = node["top"]
        top_words.append(item)
        top_words.sort(key=word_weight, reverse=True)

        while len(top_words) > MAX_SUGGESTIONS_PER_NODE:
            top_words.pop()

    def to_json(node: dict) -> dict:
        top_json = []
        for candidate in node["top"]:
            top_json.append(candidate.model_dump())

        terminal_json = None
        terminal_word = node["terminal"]
        if terminal_word is not None:
            terminal_json = terminal_word.model_dump()

        children_json = {}
        child_chars = list(node["children"].keys())
        child_chars.sort()

        for char in child_chars:
            child_node = node["children"][char]
            children_json[char] = to_json(child_node)

        result = {}
        result["top"] = top_json
        result["terminal"] = terminal_json
        result["children"] = children_json

        return result

    root = new_node()

    for item in words:
        current = root
        remember_best_words(current, item)

        for char in item.word.lower():
            children = current["children"]
            if char not in children:
                children[char] = new_node()

            current = children[char]
            remember_best_words(current, item)

        current["terminal"] = item

    return to_json(root)


@app.get("/api/words")
def list_words() -> list[WeightedWord]:
    sorted_words = list(WORDS)
    sorted_words.sort(key=word_weight, reverse=True)

    return sorted_words


@app.get("/api/trie")
def get_trie() -> dict:
    response = {}
    response["version"] = "demo-1"
    response["maxSuggestionsPerNode"] = MAX_SUGGESTIONS_PER_NODE
    response["node"] = build_weighted_trie(WORDS)

    return response
