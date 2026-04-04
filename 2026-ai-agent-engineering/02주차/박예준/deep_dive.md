# 좋은 Context Packet 설계란?

# 핵심 이론 프레임: Context as a First-Class Citizen

## RAG의 한계와 Context Engineering의 등장

RAG의 기본 파이프라인에서 "retrieval → prompt injection"의 구조는 다음 문제점을 가진다.

```
query → vector search → top-k chunks → concat → LLM
```

- 정보가 많지만 구조가 없음
- 중요도 구분 없음
- reasoning 순서 없음
- 중복 많음
- LLM이 “뭘 먼저 봐야 하는지” 모름

→ 즉, 이 접근의 문제는 **Retrieval Recall을 Prompt Quality와 동일시할 수 있다**는 점. 그래서 등장한 것이 Context Engineering https://www.anthropic.com/news/contextual-retrieval

1. _구조적 직렬화 문제 - ["Lost in the Middle: How Language Models Use Long Contexts"_ (Liu et al., 2023, Stanford)](https://arxiv.org/abs/2307.03172)
   - LLM은 긴 컨텍스트에서 **앞과 뒤의 정보만 잘 활용하고, 중간은 버린다** (U-shaped attention)
   - 단순 청크 이어붙이기는 컨텍스트 길이가 늘수록 성능 하락
   - **시사점:** 관련성 높은 내용을 앞/끝에 배치하는 *구조적 직렬화*가 필수
2. _AMBIGUOUS 패킷 - ["SELF-RAG: Learning to Retrieve, Generate, and Critique through Self-Reflection"_ (Asai et al., 2023, UW)](https://arxiv.org/abs/2310.11511)
   - 무조건 retrieval을 inject하는 것보다 **"이 retrieval이 필요한가"를 판단**하는 게 더 중요
   - **시사점:** `PacketSummary.is_ambiguous` 플래그와 AMBIGUOUS 패킷 반환이 이 원리 구현

# Context Packet이 뭔데요?

> LLM이 문제를 정확하게 풀기 위해 필요한 정보만 구조적으로 압축한 입력

- LLM에게 무엇을 주느냐가 아니라 LLM이 어떻게 사용할 것인지를 구조로 강제하는 계약
- **에이전트가 신뢰받으려면 능력, 불확실성, 한계를 투명하게 전달해야 하며, Context Packet은 이 세 가지를 LLM이 읽을 수 있는 구조로 인코딩한 계약서다**

### [비교] Context Packet vs 단순 Prompt

|               | 단순 RAG Prompt      | Context Packet                        |
| ------------- | -------------------- | ------------------------------------- |
| 구조          | 비정형 텍스트 blob   | 타입된 서브모델들의 합성체            |
| 제어          | 없음 (청크 이어붙임) | `output_contract`로 출력 형식 강제    |
| 토큰 관리     | 없음                 | `TokenBudget` + `PacketTrimmer`       |
| 불확실성 표현 | 없음                 | `retrieval_confidence`, `limitations` |
| 위치적 중요도 | 없음                 | `summary` → 앞 배치, 후보 → 뒤 배치   |

## 관련 개념

### \*RAG = **retrieval의 필요성\***

- retrieved context quality가 성능을 좌우한다
- 여기서 Context Packet 관련 개념 등장

[RAG 원논문](https://arxiv.org/abs/2005.11401)은 LLM의 parametric memory만으로는 지식 접근과 provenance 제공, 업데이트가 어렵다는 문제를 주장한다. LLM이 내부 파라미터에만 의존하면 최신성·근거성·정밀한 지식 접근에 한계가 있다고 보고, 외부 문서를 retrieve해 non-parametric memory를 generation에 결합하는 방향을 제시했다.

즉 retrieval 자체는 필요하지만, 그 다음 단계인 **어떻게 넣을지**는 별도의 설계 문제다.

> LLM = parametric memory
> Retriever = non-parametric memory

### _Context Engineering_

> Prompt is not enough. Context design matters

- LLM은 input quality에 극단적으로 민감하다
- LLM 성능 ≈ context 구조 × context 밀도

### **_Toolformer / ReAct_**

- LLM이 생각하는 순서가 중요하므로, 이 사고 순서를 미리 설계하자
- 이는 Context Packet을 “intermediate working memory”, “working memory snapshot”처럼 보게 하는 관점으로 이어진다

**_ReAct_**

- reasoning과 acting을 분리하지 않고 interleave하는 프레임워크
- 핵심 - 모델이 생각만 하는 게 아니라, 외부 정보원과 상호작용하면서 reasoning trace를 갱신하는 것

**_Toolformer_**

- 모델이 언제 어떤 API를 호출할지 배우게 하며, 외부 도구 사용을 언어 모델 능력의 일부로 본다

## Packet의 필요성

> **_Lost in the Middle_**
>
> 대규모 언어 모델(LLM)이 긴 문맥(Prompt)을 처리할 때, 시작과 끝 부분의 정보는 잘 활용하지만, 중간에 위치한 정보를 제대로 인식하거나 활용하지 못하는 현상

→ 왜 구조화·재배치·형식 강제가 필요한지를 설명할 수 있다

- Lost in the Middle은 긴 컨텍스트에서 중요한 정보가 중간에 있을 때 모델 성능이 떨어지는 경향을 보여준다
- 즉, “컨텍스트를 많이 넣는 것”과 “잘 쓰는 것”은 다르다
- 특히 관련 정보가 앞이나 뒤가 아니라 중간에 묻히면 성능이 크게 떨어질 수 있다

```
좋은 packet = 정보를 많이 담은 packet
좋은 packet ≠
좋은 packet = 중요한 정보를 앞쪽/구조적으로 드러낸 packet
```

\*_LangChain의 LongContextReorder는 long context에서 중간 정보가 잘 활용되지 않는 문제를 완화하기 위한 재배치 유틸리티로 설명한다. packet ordering은 별도 기법으로도 다뤄진다_

## 압축/토큰 예산

> packet trimming을 어떻게 생각해야 하는가
> — 긴 컨텍스트는 비용과 품질 저하를 동시에 부를 수 있기 때문

### **Prompt Compression**

- LLMLingua와 LongLLMLingua는 긴 프롬프트를 압축하면서도 의미를 보존하는 방법이다
- LongLLMLingua는 특히 long-context에서 비용, 성능 저하, position bias 문제를 동시에 지적하면서, key information density를 높이는 방향이 중요하다고 본다

[기본 설계]

1. 모든 문서를 다 넣지 않는다
2. 덜 중요한 부분을 잘라낸다
3. 핵심 정보 밀도를 높인다
4. token budget 안에서 answerability를 유지한다

### **Structured Prompting**

Anthropic 문서는 복잡한 prompt를 다룰 때 XML tags로 instructions, context, input을 명확히 구분하면 해석 오류를 줄일 수 있다고 말한다. 또한 원하는 출력 형식을 JSON, XML, template 등으로 정확히 정의하면 consistency를 높일 수 있다고 가이드한다.

⇒ Context Harness 출력 예시를 XML tag 기반으로 구조화 (e.g. <system_prompt>, <user_query>, <context> ) 하는 것이 유리하다고 설명한다

Context Packet을 설계했다면 이는 LLM으로 직렬화될 때, 다음과 같이 모델이 읽기 쉬운 형태로 만드는 것이 중요하다.

1. JSON packet
2. XML-structured prompt

즉, Context Packet은 내부적으로 Pydantic 모델이지만, LLM으로 직렬화될 때는 보통 다음 둘 중 하나로 간다.

```
1. JSON packet
2. XML-structured prompt
```

## 해결 과제

**_Context Packet은 최소한 아래 4가지 문제를 동시에 풀어야 한다._**

1. 정보 선택 - **무엇을 넣을 것인가** (selection)

   > 모든 정보를 넣는 게 아니라 답을 내는 데 필요한 최소 정보만 넣는다

   **retrieval의 top-k와 다름. top-k는 후보 집합이고, packet은 **최종 분석 입력\*\*\*

   ⚠️ 실패 패턴
   - 관련 없는 파일 포함
   - 너무 넓은 graph
   - noise 증가

2. 정보 압축 - **어떻게 줄일 것인가** (compression)

   > token budget 안에서 최대 정보 밀도
   1. 중복 제거
   2. summary field
   3. path abstraction

3. 정보 정렬 - **어떤 순서로 보여줄 것인가** (ordering)

   > LLM은 순서에 매우 민감하다 (Lost in the Middle) → 중요한 것을 앞에 두기
   - 좋은 순서: query → 핵심 요약 → 후보 → 경로 → 증거 → 제약
   - 나쁜 순서: 파일 dump → 코드 dump → 마지막에 질문

4. reasoning scaffold 제공 - **생각의 틀 제공**

   > LLM이 어떻게 생각해야 하는지 힌트를 준다

   \*_RAG의 provenance 문제와 연관_
   - 예시 : output contract
     ```json
     "output_contract": {
       "required_sections": [
         "short_summary",
         "step_by_step_flow",
         "mermaid",
         "evidence"
       ]
     }
     ```

# 적용 예시

<aside>
💡

## IDEA

```
**Context Packet =**
질의 의도, 탐색 범위, 후보, 경로, 증거, 한계를
LLM이 바로 추론 가능한 순서로 재구성한 작은 분석 입력 단위
```

- **LLM 입력 구조화 단위 -** Context Harness는 retrieval 결과를 정리·중복 제거·토큰 예산 내 압축·형식 힌트 제공까지 맡는 계층이고, 그 산출물이 ContextPacket
- 주요 설계 - **RAG**, **agent reasoning/tool use**, **long-context packing/compression**, **graph-based retrieval**, **structured prompting**
  - QueryModel - “무슨 행동을 해야 하는가”를 결정하는 intent signal이고
  - Retriever - action layer
  - ContextPacket - action 결과를 reasoning-friendly 상태로 정리한 중간 메모리
  - Analyzer - 그 위에서 설명 가능한 결론을 만듦
  - **RAG의 augmentation 단계**를 더 세분화한 설계
    ```
    query -> retrieve -> structure/pack -> analyze
    ```
    RAG survey도 retrieval, augmentation, generation을 분리해서 보며, 단순 naive RAG를 넘어서 advanced/modular RAG 쪽으로 확장될 수 있는 modular RAG의 구조다
  - **long-context 한계에 대한 대응**
    - path 중심 정렬
    - 동일 심볼 중복 제거
    - raw code보다 요약 우선
    - evidence line range 최소 포함
    - ambiguity early reject
  - **토큰 Compression**
    - LLMLingua 계열은 주로 **문자열 자체를 압축**하려는 접근이고, Context Packet은 **구조를 재편**해서 압축하는 접근이라는 점
      - token deletion보다 **semantic packing**에 가까운 방식
      - 즉, 단순히 짧게 만들기보다 정답에 필요한 정보 밀도 높이기가 맞음
    - packet trimming은 단순 truncate가 아니라 scoring + dedup + reorder여야 한다
      → Flow/Impact처럼 multi-step reasoning이 필요한 문제에서 유효함

Context Packet은 다음과 같은 의미를 가진다.

> retrieval 결과를
> 질의 의도에 맞는 reasoning surface로 재구성한
> model-facing intermediate representation

Context Packet을 거치며, retrieval 결과는 path 중심 정렬, 중복 제거, raw code보다 요약 우선, line range 포함 evidence, limitation과 confidence 분리됨

→ Retriever는 자료를 찾고 Context Packet은 문제를 풀 수 있게 재구성하는 것이 이 설계의 핵심 원칙임

---

1. Selection
   - 질문에 진짜 필요한 symbol / file / path만 남기기
2. Compression
   - token budget을 먼저 구성하고, 그 안으로 들어오도록 줄이기
3. Orderding
   - 중요한 것을 앞에 두기
   - Output Contract를 가장 먼저 정의한다
4. Reasoning Scaffold - evidence를 분리하고 line range를 남긴다 - explainability 요구사항과 직접적으로 연결됨
</aside>

## 설계 원칙

### [1] Structured over Unstructured

```python
class PacketSummary(BaseModel):
    """Analyzer가 먼저 읽을 집약 정보"""

    entrypoint_count: int = 0
    path_count: int = 0
    symbol_count: int = 0
    affected_count: int = 0
    **is_ambiguous: bool = False**
    ambiguity_reason: str | None = None

    @model_validator(mode="after")
    def validate_ambiguity_reason(self) -> "PacketSummary":
```

- **행동 조정 (단정 대신 제안) : `is_ambiguous=True`면 Analyzer 호출 자체를 금지**
- 구조화된 중간 단계를 제공할수록 LLM의 추론 정확도 상승
- `PacketSummary`는 LLM이 답변 전에 "현재 상황 요약"을 읽도록 유도 → CoT의 pre-step
- JSON/XML 구조화 입력이 비정형 입력 대비 F1 score 약 12~18% 향상
- \***_ContextPacket은 `Any`와 같은 모든 타입 허용을 방지하도록 설계하여, LLM 출력 품질을 보장하고자 함_**

### [2] Explicit Output Contract

```python
class PacketOutputContract(BaseModel):
    """Analyzer가 따라야 하는 출력 계약"""

    formats: list[OutputFormat] = Field(default_factory=lambda: [OutputFormat.SHORT_SUMMARY])
    include_evidence: bool = True
    include_mermaid: bool = False
    max_path_count: int = Field(3, ge=1, le=10)
    max_evidence_items: int = Field(5, ge=1, le=20)
```

> LLM에 주어지는 **도구 스키마**의 역할을 수행

- 출력 형식을 입력 컨텍스트에 명시할수록 format compliance 향상
  - "mermaid를 그려야 하는가?", "evidence는 최대 몇 개인가?"를 명시함으로써 LLM이 마음대로 형식을 변경하지 못하도록 할 수 있음
- LLM에게 "규칙"을 컨텍스트 안에서 명시하면 행동 통제 가능
- *입력 단계에서 출력 제약을 선언*할수록 모델 행동을 예측 가능하게 만들 수 있다
<aside>
📚

도구 설계에서의 원칙을 준수하기

> `*이름`이 일반적이면 LLM이 불필요한 상황에도 도구를 호출할 수 있다
> `스키마`가 모호할수록 파운데이션 모델이 언제, 어떻게 사용할지 정확히 이해하지 못해 오작동\*

</aside>

→ 이러한 명확한 계약이 없거나 너무 느슨하다면, LLM은 매번 다른 형식의 답변을 생성할 것임. 이게 스키마가 모호한 도구의 오작동 문제로 이어지는 것

### [3] Confidence Separation (retrieval vs. answer)

```python
class PacketMetadata(BaseModel):
    """모델 출력 판단에 필요한 메타데이터"""

    **retrieval_confidence: float = Field(0.0, ge=0.0, le=1.0)** # 명시적 진술 ("정답일 확률 90%")
    answer_confidence: float | None = Field(None, ge=0.0, le=1.0)
    limitations: list[str] = Field(default_factory=list)
    token_budget: TokenBudget
```

- **불확실성을 줄이기 위한 수단**
- LLM의 self-reported confidence는 실제 correctness와 분리되어야 신뢰 가능
- **retrieval confidence**: 그래프/벡터 검색의 질 (시스템이 측정, deterministic)
- **answer confidence**: LLM이 답변하면서 평가한 확신도 (LLM이 후처리에서 채움)
- 모르는 것을 "모른다"고 표현하는 LLM이 실제 태스크에서 더 유용
- `retrieval_confidence`는 retrieval 단계에서 시스템이 채우고, `answer_confidence`는 생성 단계에서 모델이 채우도록 분리하면 최종 답변의 confidence를 유의미하게 만들 수 있다
  ⇒ 검색은 맞았는데 해석이 애매한 상황을 구분할 수 있다

fyi. [**"FreshLLMs"** (Vu et al., 2023)](https://arxiv.org/abs/2310.03214) — retrieval confidence vs. answer confidence 분리

### [4] Ambiguity as a First-Class State

```python
def _detect_ambiguity(retrieval: RetrievalResult, budget_total: int) -> _AmbiguityDecision:
    if len(retrieval.entry_candidates) >= 3:  # 후보 3개
        scores = sorted((symbol.final_score for symbol in retrieval.entry_candidates), reverse=True)
        if scores and (scores[0] - scores[-1]) < 0.15:  # score 차이 < 0.15 -> _detect_ambiguity() → is_ambiguous=True
            return _AmbiguityDecision(True, "entry candidate 점수 차이가 작아 모호합니다.")

    estimated_tokens = (
        len(retrieval.entry_candidates) * 120
        + len(retrieval.relevant_symbols) * 80
        + len(retrieval.graph_paths) * 200
    )
    if estimated_tokens > budget_total * 1.3:
        return _AmbiguityDecision(True, "retrieval 컨텍스트가 예산 대비 과도합니다.")

    return _AmbiguityDecision(False, None)
```

- 불확실한 retrieval로 답변을 강제하는 것은 hallucination을 유발
- AMBIGUOUS 상태에서 명확화 질문을 요청하는 것이 더 나은 UX임
- retrieval이 불필요하거나 불명확할 때 "abstain" 할 수 있는 능력이 시스템 신뢰도를 높임
- 이후 실행가능한 다음 단계로 넘어가도록 return 하는 처리로 유도하는 것이 graceful failure

### [5] Token Budget as Architecture

```python
class PacketTrimmer:
    """패킷을 토큰 예산 안으로 정리한다"""

    @staticmethod
    def trim(packet: ContextPacket) -> ContextPacket:
        sorted_paths = sorted(packet.paths, key=lambda item: item.score, reverse=True)
        trimmed_paths = sorted_paths[: packet.output_contract.max_path_count]
        ...
        evidence = packet.evidence[: packet.output_contract.max_evidence_items]
```

- 토큰 수는 attention complexity에 직결 (O(n²))
- 무의미한 토큰 증가는 중요 신호를 희석시킴
- 컨텍스트 길이 > 8k 이후 점진적 성능 저하 관찰
- **짧고 dense한 컨텍스트가 긴 sparse 컨텍스트보다 우수**

**[Intent별 슬롯 할당] — Graph+Vector를 혼용하는 구조로 설계**

| Intent  | graph 70% | vector 25% | 이유                                           |
| ------- | --------- | ---------- | ---------------------------------------------- |
| FLOW    | 70%       | 25%        | 실행 경로는 그래프에서, 의미적 보완은 벡터에서 |
| IMPACT  | 85%       | 10%        | 의존성 그래프가 핵심, 의미 유사성은 부수적     |
| PATTERN | 15%       | 80%        | "비슷한 구현"은 의미 벡터가 핵심               |
| ERROR   | 40%       | 55%        | 스택 트레이스(그래프) + 오류 메시지(벡터) 균형 |

_fyi. "[Long Context vs. RAG for LLMs"_ (Xu et al., 2024)](https://arxiv.org/abs/2407.16833) — TokenBudget의 필요성

## 최종 ContextPacket 코드

```python
class ContextPacket(BaseModel):
    """LLM 입력 직전의 정제된 컨텍스트"""

    output_contract: PacketOutputContract # 출력에 대한 계약은 패킷의 첫 번째 필드이거나 XML 직렬화 시 최상단에 위치해야 LLM이 더 잘 준수함
    packet_version: str = "v1"
    query: PacketQuery
    scope: PacketScope
    summary: PacketSummary. # ← 두 번째 (U-shape 활용)
    candidates: PacketCandidates
    paths: list[GraphPath] = Field(default_factory=list)
    evidence: list[EvidenceItem] = Field(default_factory=list).  # ← 마지막 (U-shape 활용)
    impact_nodes: list[ImpactNode] = Field(default_factory=list)
    metadata: PacketMetadata
```

좋은 설계는 결국 **deterministic한 답변** 으로 정리할 수 있다

- 명확한 query
- 제한된 scope
- 핵심 path
- 증거 기반
- output 구조 강제

를 기반으로 위와 같이 설계!

<aside>
📚

### 에이전트 시스템의 UX 설계 원칙과 대응시키자면?

| UX 원칙                    | Context Packet                                                              |
| -------------------------- | --------------------------------------------------------------------------- |
| 능력을 명확히 전달하기     | `PacketOutputContract` — LLM에게 "이 패킷으로 무엇을 해야 하는가"를 명시    |
| 컨텍스트를 신중히 유지하기 | `PacketScope`, `PacketQuery` — 세션 정보를 구조화해서 전달                  |
| 신뢰 구축하기              | `retrieval_confidence` + `limitations` — 불확실성을 명시적으로 전달         |
| 오류를 우아하게 처리하기   | `is_ambiguous` + `ambiguity_reason` — Graceful Failure를 패킷 레벨에서 선언 |

</aside>
