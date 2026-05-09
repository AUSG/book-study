# Sticky Session, Load Balancing, Statefulness로 이해하는 LLM Inference System

## 목차

```text
0. 한 문장으로 보는 핵심
1. 먼저 용어를 정리하자
2. 일반 웹 시스템에서 sticky session을 왜 피하려고 할까?
3. LLM inference의 기본 흐름
4. Sticky session이 LLM inference에서 다시 중요해지는 이유
5. LLM serving에서 load balancing이 어려운 이유
6. Batching: LLM serving의 또 다른 핵심
7. Prefix caching과 sticky routing
8. Stateful worker로서의 LLM inference engine
9. Routing metadata는 어디에 둘까?
10. Consistent hashing은 도움이 될까?
11. 장애가 나면 어떻게 될까?
12. Prefill/Decode 분리와 sticky session의 변화
13. Chunked prefill과 scheduling
14. LLM load balancer가 봐야 하는 지표
15. 설계 패턴
16. Sticky session을 쓸지 말지 판단하는 질문
17. 예제 시나리오로 이해하기
18. 흔한 오해
19. 관찰해야 할 메트릭
20. 간단한 라우팅 의사코드
21. 1년차 백엔드 엔지니어를 위한 학습 순서
22. 토론 문제
23. 이번 주차 개념과의 연결 지도
24. 요약
25. 참고자료와 각주
```

---

## 0. 한 문장으로 보는 핵심

일반 백엔드 시스템에서는 상태를 서버 밖으로 빼서 stateless하게 만들수록 확장이 쉬워진다.  
반대로 LLM inference system에서는 GPU 안에 생기는 비싼 상태, 특히 KV cache를 잘 유지하고 재사용할수록 성능이 좋아진다.

이 차이 때문에 sticky session, load balancing, statefulness가 LLM serving에서는 더 어려운 문제로 바뀐다.

이 문장을 조금 풀어보면, 일반 웹 서버에서 상태는 종종 운영상의 부담이다. 특정 서버 메모리에만 로그인 세션이 있으면 그 서버가 죽었을 때 사용자가 로그아웃될 수 있고, 배포나 autoscaling 때도 세션을 어떻게 옮길지 고민해야 한다. 그래서 많은 백엔드 시스템은 상태를 DB, Redis, Kafka, object storage 같은 외부 시스템으로 빼고, 애플리케이션 서버는 최대한 교체 가능한 worker처럼 만들려고 한다.

그런데 LLM inference에서는 같은 원칙을 그대로 적용하기 어렵다. GPU worker 안에는 이미 계산해 둔 KV cache가 있고, 이 cache는 다음 token을 빠르게 생성하기 위해 매우 중요하다. 이 상태를 버리고 아무 worker로나 요청을 보내면 구조는 단순해지지만, 긴 prompt를 다시 계산해야 해서 latency와 GPU 비용이 커질 수 있다. 즉 LLM serving에서는 state가 단순한 운영 부담이 아니라 성능을 만들어내는 자산이 된다.

---

## 1. 먼저 용어를 정리하자

### 1.1 Sticky session

Sticky session은 같은 클라이언트, 같은 세션, 또는 같은 작업 흐름에 속한 요청을 계속 같은 backend instance로 보내는 방식이다.<sup>[K8s](#ref-k8s-session)</sup> <sup>[NGINX](#ref-nginx-session)</sup> <sup>[Envoy stateful session](#ref-envoy-stateful-session)</sup>

처음 sticky session을 배울 때는 "같은 사용자를 같은 서버로 보내는 설정" 정도로 이해하기 쉽다. 하지만 더 정확하게는 load balancer가 요청을 완전히 독립적으로 분산하지 않고, 어떤 key를 기준으로 backend 선택에 기억을 부여하는 방식이라고 볼 수 있다. 그 key는 client IP일 수도 있고, cookie 안의 session id일 수도 있고, header에 담긴 correlation id일 수도 있다. 중요한 점은 load balancer가 "이 요청은 이전 요청과 같은 흐름에 속한다"고 판단하고 같은 backend를 다시 선택한다는 것이다.

이 방식은 서버 내부에 의미 있는 상태가 있을 때 편리하다. 예를 들어 로그인 세션이 Server 1의 메모리에만 있다면 다음 요청도 Server 1로 가야 인증 상태를 유지할 수 있다. 반대로 모든 서버가 Redis에서 세션을 읽는다면 특정 서버에 붙을 필요가 줄어든다. 그래서 sticky session은 "서버 안의 상태를 계속 사용하고 싶다"는 설계 의도가 드러나는 신호이기도 하다.

일반 웹 서비스 예시:

```text
Client A -> Load Balancer -> Server 1
Client A -> Load Balancer -> Server 1
Client A -> Load Balancer -> Server 1

Client B -> Load Balancer -> Server 2
Client B -> Load Balancer -> Server 2
```

왜 쓰는가?

- 서버 로컬 메모리에 로그인 세션이 있을 때
- 장바구니 같은 임시 상태가 서버에 있을 때
- WebSocket처럼 연결이 오래 유지될 때
- stateful model이나 long-running sequence를 같은 instance에서 처리해야 할 때

왜 조심해야 하는가?

- 특정 서버에 요청이 몰릴 수 있다.
- 서버가 죽으면 그 서버에 있던 상태도 같이 사라질 수 있다.
- autoscaling, rolling deploy, failover가 어려워진다.
- 클라이언트 IP 기반 stickiness는 NAT, 프록시, 모바일 네트워크에서 부정확할 수 있다.<sup>[NGINX](#ref-nginx-session)</sup>

### 1.2 Load balancing

Load balancing은 여러 backend instance 중 어느 곳으로 요청을 보낼지 결정하는 일이다.

로드 밸런싱은 단순히 트래픽을 고르게 나누는 기능처럼 보이지만, 실제로는 시스템의 병목과 장애 양상을 결정하는 중요한 제어 지점이다. 같은 요청이라도 어떤 backend로 보내느냐에 따라 cache hit가 날 수도 있고, queue에서 오래 기다릴 수도 있으며, 이미 warm-up된 model을 사용할 수도 있고, cold start를 만날 수도 있다. 특히 LLM serving에서는 이 선택이 GPU 비용과 사용자 체감 지연으로 바로 이어진다.

대표 전략:

```text
Round Robin       : 1번, 2번, 3번, 다시 1번 ...
Least Connections : 현재 연결 수가 가장 적은 서버 선택
Weighted LB       : 더 강한 서버에 더 많은 요청 배정
IP Hash           : client IP hash로 서버 선택
Consistent Hash   : key hash로 서버 선택, 서버 추가/삭제 시 이동 최소화
Power of Two      : 두 서버를 샘플링해서 더 한가한 서버 선택
```

일반적인 API 서버에서는 요청 1개의 비용이 대략 비슷하다고 가정할 때가 많다.  
하지만 LLM inference에서는 이 가정이 크게 깨진다.

예를 들어:

```text
요청 A: "hi" -> 20 input tokens, 30 output tokens
요청 B: 100페이지 문서 요약 -> 80,000 input tokens, 2,000 output tokens
```

두 요청은 모두 "HTTP request 1개"이지만 GPU 비용은 전혀 다르다.

1년차 백엔드 엔지니어가 여기서 특히 조심해야 할 함정은 "request 수"와 "작업량"을 같은 것으로 보는 습관이다. CRUD API에서는 request 수가 꽤 쓸 만한 부하 지표일 때가 많지만, LLM API에서는 input token 수와 output token 수가 실질적인 작업량에 더 가깝다. 그래서 LLM 시스템의 로드 밸런서는 HTTP 레벨의 요청 분산기라기보다, GPU에서 실행될 계산량을 예측하는 scheduler에 가까워진다.

### 1.3 Statefulness

Stateful service는 요청 사이에 서버 내부 상태를 유지한다.

Stateless service는 각 요청을 독립적으로 처리한다. 필요한 상태는 DB, Redis, object storage 같은 외부 저장소에서 읽는다.

stateful과 stateless를 구분할 때 "상태가 있느냐 없느냐"라고만 외우면 헷갈리기 쉽다. 현실의 거의 모든 서비스는 어딘가에는 상태를 가진다. 사용자의 계정 정보도 상태이고, 주문 내역도 상태이며, 채팅 기록도 상태다. 차이는 그 상태가 개별 애플리케이션 서버의 로컬 메모리나 디스크에 묶여 있는지, 아니면 여러 서버가 공통으로 접근할 수 있는 외부 저장소에 있는지에 있다.

stateless API server라는 말은 "이 서버가 아무 정보도 다루지 않는다"는 뜻이 아니다. "이 서버가 사라져도 다음 요청을 다른 서버가 같은 방식으로 처리할 수 있도록, 중요한 상태를 서버 밖에 둔다"는 뜻에 가깝다. 이 관점은 LLM inference를 볼 때도 중요하다. API gateway나 billing service는 stateless하게 만들 수 있지만, GPU worker의 KV cache까지 같은 방식으로 쉽게 외부화할 수 있는지는 별개의 문제다.

일반 백엔드에서는 보통 이렇게 설계하려고 한다.

```text
Client
  |
Load Balancer
  |
Stateless API Servers
  |
External State: DB / Redis / Kafka / Object Storage
```

이 구조의 장점:

- 서버를 쉽게 늘리고 줄일 수 있다.
- 특정 서버가 죽어도 다른 서버가 요청을 처리할 수 있다.
- rolling deploy가 쉽다.
- load balancing이 단순하다.

하지만 LLM inference에서는 GPU worker 내부 상태가 성능의 핵심이 된다.

---

## 2. 일반 웹 시스템에서 sticky session을 왜 피하려고 할까?

### 2.1 예시: 로그인 세션을 서버 메모리에 저장하는 서비스

초기 구현:

```text
Server 1 memory:
  session_id=abc -> user_id=1

Server 2 memory:
  empty
```

사용자가 로그인한 뒤 Server 1에 세션이 생겼다. 다음 요청이 Server 2로 가면 Server 2는 이 사용자를 모른다.

해결책 1: sticky session

```text
session_id=abc 요청은 계속 Server 1로 보낸다.
```

해결책 2: 세션 저장소 외부화

```text
Server 1, Server 2 모두 Redis에서 session_id를 조회한다.
```

일반 웹 백엔드에서는 대개 해결책 2가 더 확장성 있는 방향이다.

이 예시는 sticky session이 왜 매력적인 동시에 위험한지를 잘 보여준다. sticky session을 쓰면 당장 Redis를 도입하지 않아도 로그인 상태가 유지된다. 작은 서비스에서는 이 선택이 빠르고 실용적일 수 있다. 하지만 서버가 늘어나고, 사용자가 많아지고, 배포가 잦아지면 특정 서버에 세션이 묶여 있다는 사실이 점점 발목을 잡는다. 서버 한 대를 내리기 전에 세션을 drain해야 하고, 장애가 나면 그 서버에 붙어 있던 사용자의 상태를 잃을 수 있다.

그래서 많은 웹 백엔드 설계에서는 sticky session을 장기적인 기본값으로 두기보다, 상태를 외부 저장소로 옮겨 서버를 대체 가능하게 만드는 방향을 선호한다. 이 사고방식이 일반 시스템 디자인의 중요한 기본기다. 다만 이 기본기가 LLM inference에서는 곧바로 정답이 되지 않는다는 점이 이번 자료의 핵심이다.

### 2.2 Sticky session의 근본적인 트레이드오프

Sticky session은 local state를 재사용하기 쉽게 해준다.  
하지만 load balancer가 자유롭게 요청을 분산할 수 없게 만든다.

```text
장점:
  local state 재사용
  외부 저장소 조회 감소
  stateful protocol 처리 쉬움

단점:
  부하 불균형
  장애 복구 어려움
  scale in/out 시 세션 이동 문제
  특정 backend hot spot 가능
```

이 트레이드오프는 LLM inference에서 훨씬 강하게 나타난다.<sup>[Envoy stateful session](#ref-envoy-stateful-session)</sup>

왜 더 강하게 나타날까? 일반 웹 서버의 local state는 Redis로 옮길 수 있는 경우가 많지만, LLM worker의 KV cache는 GPU memory에 있는 대형 tensor이며, 매 token 생성마다 빠르게 접근되어야 한다. 이것을 네트워크 너머의 저장소에 두면 decode path가 너무 느려질 수 있고, 다른 GPU로 옮기는 것도 bandwidth와 serialization 비용이 크다. 그래서 LLM에서는 "state를 없애자"보다 "state를 어느 정도 붙잡되, 그 부작용을 어떻게 제어할까"가 더 현실적인 질문이 된다.

---

## 3. LLM inference의 기본 흐름

LLM은 한 번에 전체 답변을 만드는 것이 아니라, 보통 다음 토큰을 하나씩 생성한다.<sup>[Orca](#ref-orca)</sup>

사용자 입장에서는 ChatGPT류 서비스가 문장을 자연스럽게 이어서 쓰는 것처럼 보이지만, 내부적으로는 매 순간 "지금까지의 문맥을 보고 다음 token 하나를 고르는 과정"이 반복된다. 여기서 token은 꼭 단어 하나와 같지는 않다. 영어 단어의 일부일 수도 있고, 한국어 음절이나 기호 조각일 수도 있다. 중요한 것은 모델이 답변 전체를 한 번에 완성된 문자열로 뱉는 것이 아니라, 이전에 생성한 token을 다시 입력 문맥에 포함하며 다음 token을 계속 만들어간다는 점이다.

```text
Input prompt:
  "Kubernetes의 sticky session을 설명해줘"

Step 1: 다음 토큰 생성
Step 2: 그 토큰을 포함해 다음 토큰 생성
Step 3: 다시 다음 토큰 생성
...
```

이 과정을 autoregressive generation이라고 부른다.

### 3.1 Prefill과 decode

LLM inference는 크게 두 단계로 나눠 볼 수 있다.

prefill과 decode를 나눠 보는 습관은 LLM serving을 이해하는 데 매우 중요하다. 두 단계는 모두 같은 모델을 실행하지만 성격이 다르다. prefill은 긴 입력 prompt를 한 번에 읽어들이는 단계라서 input token 수에 민감하다. decode는 이미 읽은 문맥을 바탕으로 output token을 하나씩 생성하는 단계라서 생성 길이와 동시에 살아 있는 sequence 수에 민감하다.

```text
1. Prefill
   입력 prompt 전체를 모델에 통과시켜 초기 KV cache를 만든다.

2. Decode
   KV cache를 사용해 output token을 하나씩 생성한다.
```

간단히 말하면:

```text
Prefill = 질문을 읽는 단계
Decode  = 답변을 한 글자씩 쓰는 단계
```

성능 지표도 단계별로 나뉜다.

```text
TTFT: Time To First Token
  요청 후 첫 토큰이 나오기까지의 시간
  prefill 비용의 영향을 크게 받는다.

TPOT: Time Per Output Token
  이후 토큰 하나를 생성하는 데 걸리는 시간
  decode 비용의 영향을 크게 받는다.

E2E latency:
  전체 답변이 끝날 때까지 걸리는 시간

Throughput:
  초당 처리 token 수, 초당 처리 request 수
```

예를 들어 사용자가 100페이지 문서를 넣고 "세 줄로 요약해줘"라고 요청하면 prefill이 무겁고 decode는 상대적으로 짧을 수 있다. 반대로 짧은 질문에 대해 매우 긴 코드를 생성하게 하면 prefill은 가볍지만 decode가 오래 걸린다. 이 차이를 구분하지 않으면 "왜 어떤 요청은 첫 토큰이 늦고, 어떤 요청은 첫 토큰은 빨리 나오는데 끝나기까지 오래 걸리는지" 설명하기 어렵다.

### 3.2 KV cache란 무엇인가?

Transformer는 attention을 계산할 때 이전 token들의 key/value tensor를 사용한다.<sup>[PagedAttention](#ref-pagedattention)</sup>  
매번 이전 token 전체를 다시 계산하면 너무 비싸기 때문에, 이전 token들의 key/value를 cache로 저장한다.

```text
Prompt tokens:
  t1, t2, t3, t4

Model computes:
  K1,V1
  K2,V2
  K3,V3
  K4,V4

KV cache:
  [K1,V1], [K2,V2], [K3,V3], [K4,V4]
```

다음 토큰 t5를 만들 때는 이전 token들의 KV cache를 재사용한다.

```text
Generate t5 using:
  current query + cached [K1,V1..K4,V4]
```

즉 KV cache는 "이 conversation/request의 이전 문맥을 모델이 이미 계산한 결과"라고 볼 수 있다.

KV cache가 없다면 모델은 다음 token을 만들 때마다 앞의 모든 token에 대한 key/value를 반복해서 계산해야 한다. 짧은 문장에서는 큰 차이가 없어 보일 수 있지만, context가 수천, 수만 token으로 길어지면 이 반복 계산은 감당하기 어려워진다. KV cache는 이 반복을 줄여주는 핵심 최적화다. 대신 cache를 저장할 memory가 필요하고, sequence가 길어질수록 cache도 함께 커진다.

### 3.3 KV cache는 Redis cache와 무엇이 다른가?

둘 다 cache라는 이름을 쓰지만 성격이 많이 다르다.

| 항목 | Redis cache | LLM KV cache |
|---|---|---|
| 주 저장 위치 | CPU memory / network memory | GPU memory |
| 데이터 형태 | JSON, string, object 등 | model layer별 tensor |
| key | user id, object id, query 등 | token prefix, request/sequence, block hash |
| 이동 비용 | 상대적으로 낮음 | 매우 높음 |
| 재계산 비용 | DB 조회 정도 | GPU prefill 재실행 |
| 수명 | 비교적 길 수 있음 | request/session/context에 묶임 |
| 공유 가능성 | application logic에 따라 쉬움 | model/version/tokenizer/prefix가 같아야 함 |

중요한 포인트:

KV cache는 보통 GPU memory에 있다. GPU memory는 비싸고 작고, network로 옮기기도 어렵다.<sup>[PagedAttention](#ref-pagedattention)</sup>

그래서 "그냥 Redis에 넣으면 되지 않나?"라고 생각하면 안 된다.  
KV cache는 크고, tensor 형태이며, 매 decode step마다 빠르게 접근해야 한다.

Redis cache는 보통 "나중에 다시 써도 되는 application-level 결과"를 저장한다. 반면 KV cache는 모델 실행 중간에 생기는 내부 계산 상태다. 사용자가 직접 이해할 수 있는 JSON 객체가 아니라, 특정 모델의 특정 layer와 head에 맞춰진 tensor다. model version, tokenizer, attention 구현, sequence 위치가 달라지면 그대로 재사용하기 어렵다. 그래서 이름은 cache이지만 운영 감각은 일반적인 웹 cache보다 GPU memory allocator와 runtime state에 더 가깝다.

---

## 4. Sticky session이 LLM inference에서 다시 중요해지는 이유

### 4.1 일반 웹과 LLM의 차이

일반 웹:

```text
가능하면 API server를 stateless하게 만들자.
상태는 DB/Redis로 빼자.
그러면 아무 서버나 요청을 처리할 수 있다.
```

LLM inference:

```text
GPU worker 안에 KV cache가 있다.
그 worker에 다시 보내면 prefill을 덜 할 수 있다.
다른 worker로 보내면 cache miss 또는 cache 이동/재계산이 필요하다.
```

이 대비가 직관적으로 와닿아야 한다. 일반 웹에서는 같은 요청을 Server 1이 처리하든 Server 2가 처리하든 DB와 Redis만 같으면 결과가 같아야 한다. 그래서 load balancer는 가능한 한 backend를 자유롭게 고를 수 있다. LLM inference에서는 같은 model replica라 해도 worker마다 들고 있는 KV cache와 prefix cache가 다를 수 있다. 따라서 "아무 worker나 가능하다"는 말은 correctness 관점에서는 맞더라도, performance 관점에서는 틀릴 수 있다.

그래서 LLM에서는 다음 질문이 생긴다.

```text
같은 대화의 다음 요청을 이전 KV cache가 있는 GPU worker로 보내야 할까?
같은 긴 문서 prefix를 공유하는 요청을 같은 worker로 보내야 할까?
부하가 몰려도 cache locality를 우선해야 할까?
아니면 cache miss를 감수하고 한가한 worker로 보내야 할까?
```

### 4.2 Sticky의 단위가 달라진다

일반 웹에서는 sticky 단위를 user/session으로 생각하기 쉽다.

LLM에서는 더 세밀하게 봐야 한다.

| Sticky 단위 | 의미 | 장점 | 위험 |
|---|---|---|---|
| User 단위 | 같은 사용자는 같은 worker | 단순함 | 한 사용자의 무거운 요청이 worker를 점유 |
| Conversation 단위 | 같은 채팅방은 같은 worker | multi-turn cache 재사용 | 긴 대화 hot spot |
| Request/Sequence 단위 | 진행 중인 생성은 같은 worker | decode에 필수적 | 완료 후 재사용 약함 |
| Prefix 단위 | 같은 prompt prefix는 같은 worker | prefix cache hit 증가 | routing metadata 필요 |
| Tenant 단위 | 같은 고객사는 같은 pool | 보안/격리 쉬움 | 자원 활용률 저하 |

실무적으로는 "사용자 단위 sticky"보다 "prefix/cache-aware routing"이 더 중요해질 수 있다.

예를 들어 한 사용자가 여러 프로젝트에 대해 질문한다면 user 단위 sticky는 별로 도움이 되지 않을 수 있다. 같은 사용자의 요청이라도 prefix가 완전히 다르면 cache reuse가 어렵기 때문이다. 반대로 서로 다른 사용자가 같은 긴 문서를 기반으로 질문한다면 user는 달라도 document prefix는 같으므로 같은 cache를 재사용할 여지가 생긴다. 이 때문에 LLM serving에서는 "누가 보냈는가"뿐 아니라 "어떤 token prefix를 공유하는가"가 routing key 후보가 된다.

---

## 5. LLM serving에서 load balancing이 어려운 이유

### 5.1 요청 비용이 균일하지 않다

일반 API:

```text
GET /users/1
GET /users/2
GET /users/3
```

각 요청의 비용이 완전히 같지는 않아도, 대체로 비슷하다고 볼 수 있다.

물론 일반 API도 비용이 모두 같지는 않다. 어떤 endpoint는 DB join이 많고, 어떤 endpoint는 외부 API를 호출할 수 있다. 그래도 많은 웹 서비스에서는 endpoint별 latency와 CPU 사용량이 어느 정도 예측 가능하고, request count나 active connection 수가 부하를 대략 표현해준다. 그래서 round robin, least connections, weighted load balancing 같은 범용 전략이 꽤 잘 동작한다.

LLM API:

```text
Request A:
  input 20 tokens, output 50 tokens

Request B:
  input 100,000 tokens, output 200 tokens

Request C:
  input 500 tokens, output 8,000 tokens
```

비용을 대략 이렇게 나눌 수 있다.

```text
Prefill cost ~= input tokens에 비례
Decode cost  ~= output tokens와 active sequence 수에 비례
KV memory    ~= input tokens + generated tokens에 비례
```

따라서 request count만 보고 load balancing하면 잘못된 결정을 하기 쉽다.

LLM serving에서 "현재 worker A는 request 3개, worker B는 request 5개니까 A가 더 한가하다"라고 판단하면 위험하다. worker A의 request 3개가 모두 긴 output을 생성 중이라면 decode slot을 오래 점유할 수 있고, worker B의 request 5개가 짧은 응답이라면 곧 끝날 수도 있다. 또한 worker A가 긴 prompt prefill을 막 시작했다면 새 요청의 TTFT가 크게 밀릴 수 있다. 그래서 LLM load balancing은 요청 개수보다 token 단위의 예상 작업량과 queue 상태를 봐야 한다.

### 5.2 Queueing delay가 중요하다

GPU worker는 여러 요청을 batch로 묶어 처리한다.

```text
Worker queue:
  req1: decoding
  req2: decoding
  req3: prefill pending
  req4: decoding
```

새 요청을 어디로 보낼지는 단순히 "현재 요청 수"만으로 결정하기 어렵다.

queueing delay는 사용자가 체감하는 latency의 숨은 원인이다. 모델 자체의 계산 시간이 200ms라도, GPU worker 앞 queue에서 2초 기다리면 사용자는 2초 넘게 아무 token도 받지 못한다. 특히 streaming 서비스에서는 첫 token이 언제 나오느냐가 중요하기 때문에, prefill queue가 막혀 있는지 decode가 밀리고 있는지를 구분해야 한다.

고려할 정보:

- active sequence 수
- waiting queue 길이
- 각 요청의 prompt 길이
- max output token 설정
- 현재 KV cache memory 사용량
- prefix cache hit 가능성
- GPU utilization
- model replica별 warm/cold 상태
- tenant priority
- timeout/SLO

### 5.3 Cache locality와 load balance가 충돌한다

상황:

```text
Worker A:
  해당 conversation의 KV cache 있음
  하지만 queue가 길다

Worker B:
  KV cache 없음
  하지만 한가하다
```

선택지:

```text
1. Worker A로 보낸다.
   cache hit, prefill 절약
   하지만 queue 대기 증가

2. Worker B로 보낸다.
   queue 대기 감소
   하지만 prefill 재계산
```

좋은 router는 둘 중 하나를 무조건 고르지 않는다.  
예상 비용을 비교해야 한다.

이 장면이 LLM-aware routing의 핵심이다. cache locality만 보면 Worker A가 좋아 보이고, load balancing만 보면 Worker B가 좋아 보인다. 하지만 실제 목표는 "cache hit 자체"도 아니고 "가장 한가한 worker 선택"도 아니다. 사용자의 SLO 안에서 GPU를 효율적으로 쓰는 것이 목표다. 따라서 router는 cache hit로 절약할 prefill 시간과 queue에서 추가로 기다릴 시간을 비교해야 한다. 이 판단이 정확해질수록 tail latency와 throughput을 동시에 개선할 가능성이 커진다.

```text
예상 latency =
  queueing delay
  + prefill cost after cache hit/miss
  + decode cost
  + possible transfer/recompute cost
```

---

## 6. Batching: LLM serving의 또 다른 핵심

### 6.1 왜 batching을 하는가?

GPU는 작은 요청 하나씩 처리할 때보다 여러 요청을 묶어서 처리할 때 효율이 좋아진다.

GPU는 대량의 병렬 계산을 잘 처리하도록 설계되어 있다. 그래서 아주 작은 작업을 하나씩 던지면 GPU 자원이 충분히 채워지지 않고, kernel launch overhead나 memory access overhead가 상대적으로 크게 느껴질 수 있다. 여러 요청을 한 batch로 묶으면 한 번의 model 실행에서 더 많은 token을 처리할 수 있어 throughput이 좋아진다. 이 때문에 model serving 시스템은 어느 정도의 대기 시간을 감수하고 request를 모아 batch를 만들기도 한다.

```text
req1 -> GPU
req2 -> GPU
req3 -> GPU
```

보다:

```text
[req1, req2, req3] -> GPU batch
```

가 throughput 측면에서 유리하다.

Triton Inference Server 문서에서도 dynamic batching은 개별 inference request를 서버에서 묶어 throughput을 높이는 기능으로 설명된다. 다만 stateless model에는 dynamic batcher를, sequence가 같은 model instance로 가야 하는 stateful model에는 sequence batcher를 쓰는 식으로 구분한다.<sup>[Triton](#ref-triton-batching)</sup>

이 구분은 LLM inference를 이해하는 좋은 출발점이다. stateless model이라면 어떤 요청 두 개를 같은 batch에 넣어도 서로의 다음 요청과 연결되지 않는다. 하지만 stateful model에서는 sequence의 앞뒤 관계가 중요하다. LLM의 active generation은 명시적인 sequence state를 가지므로, 단순히 들어온 요청들을 임의로 묶는 것만으로는 충분하지 않다. 어떤 sequence가 어느 worker에서 어느 KV cache를 들고 진행 중인지까지 함께 관리해야 한다.

### 6.2 LLM batching은 일반 model serving보다 까다롭다

이미지 분류 모델:

```text
입력 이미지 8장 -> batch 한번 -> 결과 8개
```

LLM:

```text
req1: output 20 tokens
req2: output 500 tokens
req3: output 3 tokens
```

요청마다 끝나는 시점이 다르다.  
짧은 요청은 빨리 끝나고, 긴 요청은 계속 decode step을 돈다.

그래서 request-level batching만으로는 비효율이 생긴다.

이미지 분류에서는 batch 안의 모든 이미지가 한 번 forward pass를 거치면 끝난다. 하지만 LLM에서는 같은 batch에 들어간 요청들이 서로 다른 길이의 답변을 생성한다. 어떤 요청은 세 token 만에 끝나고, 어떤 요청은 수천 token을 더 생성한다. 짧은 요청이 끝난 뒤에도 batch 구조가 고정되어 있으면 빈 slot이 생기고, 새로 도착한 요청은 이미 실행 중인 긴 요청이 끝날 때까지 기다려야 할 수 있다.

### 6.3 Iteration-level scheduling

Orca 논문은 LLM generation이 여러 iteration으로 진행된다는 점에 주목한다.<sup>[Orca](#ref-orca)</sup>  
한 request 전체를 batch에 고정하는 대신, 한 token 생성 iteration 단위로 scheduling하는 아이디어가 중요하다.

개념적으로 보면:

```text
기존 request-level batching:
  batch = [req1, req2, req3]
  req1이 끝나도 req2/req3이 끝날 때까지 batch 구조가 뻣뻣함

iteration-level scheduling:
  매 decode iteration마다 batch 구성을 조정
  끝난 요청은 빠지고 새 요청이 들어올 수 있음
```

LLM serving system이 일반 API load balancer보다 scheduler에 가까워지는 이유다.

여기서 scheduler라는 표현이 중요하다. 일반 load balancer는 request를 backend로 한 번 넘기면 역할이 거의 끝난다. 반면 LLM serving scheduler는 살아 있는 sequence들을 계속 관찰하면서, 이번 iteration에서 어떤 sequence들을 함께 실행할지 반복적으로 결정한다. 새 요청을 받아들이고, 끝난 요청을 제거하고, 긴 prefill과 짧은 decode를 섞는 일이 모두 scheduler의 책임이 된다.

---

## 7. Prefix caching과 sticky routing

### 7.1 Prefix caching이란?

Prefix caching은 같은 prompt prefix를 가진 요청들이 이전에 계산된 KV cache 일부를 재사용하는 기법이다.<sup>[vLLM APC](#ref-vllm-apc)</sup>

prefix caching은 LLM serving에서 "같은 일을 두 번 하지 말자"는 가장 직관적인 최적화 중 하나다. 많은 LLM 애플리케이션은 요청마다 완전히 새로운 prompt를 보내지 않는다. 같은 system prompt를 반복해서 붙이거나, 같은 문서/코드베이스/대화 history 앞부분을 여러 번 포함한다. 이때 매 요청마다 공통 prefix를 처음부터 prefill하면 GPU가 이미 했던 계산을 반복하게 된다.

예:

```text
공통 prefix:
  "다음 약관 문서를 읽고 질문에 답하세요: ...긴 문서..."

Request 1:
  prefix + "계약 해지 조건은?"

Request 2:
  prefix + "환불 정책은?"

Request 3:
  prefix + "관할 법원은?"
```

긴 문서 부분은 매번 다시 prefill할 필요가 없다.  
한 번 계산한 KV cache block을 재사용하면 TTFT와 throughput이 좋아질 수 있다.

vLLM의 Automatic Prefix Caching 문서는 같은 prefix를 공유하는 새 query가 기존 KV cache를 재사용해 shared part의 computation을 건너뛸 수 있다고 설명한다.<sup>[vLLM APC](#ref-vllm-apc)</sup>

다만 prefix caching은 output token 생성 자체를 공짜로 만들어주지는 않는다. 공통 prefix를 읽는 비용, 즉 prefill 비용을 줄이는 데 가장 직접적인 효과가 있다. 따라서 긴 문서를 반복해서 질문하는 workload에는 큰 도움이 되지만, 짧은 prompt에서 매우 긴 답변을 생성하는 workload에서는 전체 latency 중 decode 비중이 커서 효과가 제한될 수 있다. cache 최적화를 평가할 때는 "cache hit rate가 높아졌는가"뿐 아니라 "전체 latency에서 prefill이 차지하던 비중이 얼마나 되었는가"를 함께 봐야 한다.

### 7.2 Prefix-aware routing

Prefix cache가 worker local에 있다면 router가 이를 알아야 한다.

prefix cache가 모든 worker에 공유되어 있다면 routing은 상대적으로 단순해진다. 어느 worker로 보내도 cache를 사용할 수 있기 때문이다. 하지만 실제로는 KV cache가 GPU worker local memory에 있는 경우가 많고, worker마다 보유한 cache block이 다를 수 있다. 그러면 router는 단순히 "어느 worker가 한가한가"뿐 아니라 "어느 worker가 이 prefix를 이미 갖고 있는가"를 알아야 한다.

```text
Worker A:
  prefix hash X cache 있음

Worker B:
  prefix hash Y cache 있음

New request:
  prefix hash X

Router:
  Worker A로 보내면 cache hit 가능
```

Ray Serve LLM 문서는 prefix-aware routing을 통해 비슷한 prefix를 가진 요청을 같은 replica로 보내 vLLM APC의 KV cache hit rate를 높이는 방식을 제공한다.<sup>[Ray Serve](#ref-ray-prefix-routing)</sup>

여기서 sticky session의 의미가 바뀐다.

```text
전통적인 sticky session:
  같은 user/session -> 같은 server

LLM prefix-aware routing:
  같은 prefix/cache key -> 같은 worker
```

즉 "사용자 친화적인 stickiness"가 아니라 "cache locality 친화적인 stickiness"가 된다.

이 관점은 기존 웹 백엔드 사고방식에서 한 단계 넘어가는 지점이다. 예전에는 sticky session의 목적이 사용자 경험의 연속성, 예를 들어 로그인 상태 유지나 장바구니 유지였다. LLM serving에서의 stickiness는 종종 계산 locality를 위한 것이다. 같은 사용자인지는 부차적일 수 있고, 같은 token prefix를 공유하는지가 더 중요할 수 있다. 그래서 LLM router는 HTTP session보다 model input의 구조를 이해하는 방향으로 발전한다.

### 7.3 Prefix caching의 보안 이슈

Prefix cache는 멀티테넌트 환경에서 조심해야 한다.  
다른 사용자의 prompt가 cache에 있는지 latency 차이로 추측할 수 있는 timing side-channel이 생길 수 있기 때문이다.

예를 들어 어떤 공격자가 특정 민감 문서가 서비스에 이미 들어온 적이 있는지 알고 싶다고 해보자. 만약 그 문서 prefix로 요청했을 때 유난히 빠르게 첫 token이 나온다면, 공격자는 "이 prefix가 cache에 있었던 것 아닐까"라고 추측할 수 있다. 물론 실제 공격 가능성은 구현과 환경에 따라 달라지지만, multi-tenant shared cache에서는 성능 최적화가 정보 노출 경로가 될 수 있다는 점을 기억해야 한다.

vLLM은 prefix cache reuse를 격리하기 위해 request별 salt를 hash에 포함하는 cache isolation 기능을 설명한다. 같은 salt를 공유하는 trust group 안에서만 cache reuse를 허용하는 방식이다.<sup>[vLLM design](#ref-vllm-prefix-design)</sup>

백엔드 엔지니어 관점에서 기억할 점:

```text
cache hit는 성능 최적화이지만,
multi-tenant cache hit는 보안/프라이버시 설계 대상이다.
```

---

## 8. Stateful worker로서의 LLM inference engine

LLM worker는 단순히 "HTTP request를 받아서 response를 반환하는 stateless process"가 아니다.<sup>[PagedAttention](#ref-pagedattention)</sup> <sup>[vLLM design](#ref-vllm-prefix-design)</sup>

일반 백엔드에서 worker process는 보통 재시작해도 큰 문제가 없도록 설계된다. process가 죽으면 load balancer가 다른 process로 보내고, 필요한 상태는 DB나 Redis에서 다시 읽으면 된다. LLM worker도 correctness만 보면 재시작 후 새 요청을 처리할 수 있지만, 성능 관점에서는 많은 것이 사라진다. model warm-up 상태, KV cache, prefix cache, scheduler queue, memory allocation 상태가 모두 worker local에 있기 때문이다.

보통 worker 안에는 이런 상태가 있다.

```text
Model weights:
  GPU memory에 올라간 model parameter

KV cache:
  active sequence와 cached prefix block

Scheduler queue:
  waiting, prefill, decode 중인 request

Batching state:
  현재 iteration에서 함께 실행할 sequence들

Memory allocator state:
  KV cache block pool, free list, fragmentation state

Runtime state:
  CUDA graph, compiled kernel, warmed-up execution path

Adapter state:
  LoRA adapter, tenant-specific model delta
```

따라서 LLM serving architecture는 보통 이렇게 나눠 생각한다.

이 구조에서 중요한 것은 모든 계층이 같은 정도로 stateful하지 않다는 점이다. API Gateway는 인증, rate limit, request validation을 담당하면서 가능한 한 stateless하게 유지할 수 있다. 반면 GPU worker는 model weights와 KV cache를 들고 있기 때문에 stateful하다. 중간의 router/scheduler는 두 세계를 연결한다. 외부 사용자에게는 stateless API처럼 보이게 하면서, 내부적으로는 GPU-local state를 최대한 활용하도록 요청을 배치한다.

```text
                 Stateless-ish
Client -> API Gateway / Auth / Rate Limit / Billing
                   |
                   v
              Model Router
                   |
                   v
          Cache-aware Scheduler
                   |
       +-----------+-----------+
       |           |           |
       v           v           v
   GPU Worker  GPU Worker  GPU Worker
   stateful    stateful    stateful
```

---

## 9. Routing metadata는 어디에 둘까?

Sticky routing을 하려면 router가 "어떤 session/cache가 어느 worker에 있는지" 알아야 한다.

이 정보는 작아 보이지만 시스템이 커질수록 까다로운 운영 데이터가 된다. session id 하나를 worker id 하나에 매핑하는 정도라면 단순하지만, prefix cache까지 고려하면 key의 수가 빠르게 늘어난다. 또한 worker는 계속 새 cache block을 만들고 오래된 block을 evict한다. router가 보는 정보와 실제 worker 상태 사이에는 항상 시간 차이가 생긴다. 이 차이를 어떻게 허용할지가 routing metadata 설계의 핵심이다.

### 9.1 Router local memory

```text
router memory:
  conversation_id -> worker_id
  prefix_hash -> candidate workers
```

장점:

- 빠르다.
- 구현이 단순하다.

단점:

- router replica가 여러 개면 view가 달라진다.
- router가 재시작하면 정보가 사라진다.
- worker failure 반영이 어렵다.

router local memory 방식은 작은 시스템이나 단일 router에서는 꽤 매력적이다. 네트워크 hop이 없고 구현도 쉽다. 하지만 router replica가 여러 개가 되는 순간 문제가 생긴다. Router 1은 conversation A가 Worker 1에 있다고 알고, Router 2는 같은 conversation을 모를 수 있다. 이 상태에서 client request가 서로 다른 router로 들어오면 sticky routing이 깨진다. 따라서 local memory 방식은 보통 "best effort affinity"로 받아들이거나, router 앞단에서도 같은 client가 같은 router로 가도록 추가 stickiness를 둬야 한다.

### 9.2 External store

```text
Redis / etcd / coordinator:
  session_id -> worker_id
  prefix_hash -> worker list
```

장점:

- router가 여러 개여도 공유 가능하다.
- TTL, heartbeat, ownership 관리가 가능하다.

단점:

- 매 요청마다 store 조회가 늘면 latency가 증가한다.
- store 자체가 병목이나 장애 지점이 될 수 있다.
- 정보가 stale할 수 있다.

external store 방식은 분산 시스템에서 익숙한 해법이다. Redis나 etcd 같은 곳에 session map을 두면 여러 router가 같은 view를 공유할 수 있다. 하지만 이 방식도 만능은 아니다. 매 요청마다 external store를 조회하면 routing path의 latency가 늘고, store 장애가 전체 serving 장애로 번질 수 있다. 또 store에 적힌 "prefix hash X는 Worker A에 있음"이라는 정보가 실제로는 이미 evicted된 cache를 가리킬 수도 있다. 결국 TTL, heartbeat, eviction event, fallback policy를 함께 설계해야 한다.

### 9.3 Worker-reported metrics

worker가 주기적으로 자기 상태를 보고한다.

```text
Worker A reports:
  active_sequences=37
  waiting_queue=12
  kv_cache_usage=78%
  prefix_hashes=[...]
  model_id=llama-...
```

router는 이 정보를 보고 결정을 내린다.

주의할 점:

- 상태 정보는 항상 약간 과거 정보다.
- 모든 prefix hash를 보고하면 metadata가 너무 커진다.
- 요약 정보와 상세 정보 사이의 균형이 필요하다.

worker-reported metrics는 현실적인 절충안이다. worker가 자신의 queue length, KV memory usage, cache hit candidate 등을 주기적으로 보고하고, router는 이 정보를 바탕으로 결정을 내린다. 이때 모든 cache key를 중앙에 보고하려고 하면 metadata 양이 너무 커질 수 있다. 반대로 너무 요약하면 router가 cache locality를 제대로 활용하지 못한다. 실무에서는 top-K hot prefix, approximate load metric, cache utilization bucket처럼 요약된 정보를 쓰는 식의 타협이 필요해진다.

---

## 10. Consistent hashing은 도움이 될까?

Consistent hashing은 key를 기준으로 backend를 고르는 방식이다. backend가 추가/삭제될 때 전체 key가 흔들리지 않고 일부만 이동하도록 설계한다.<sup>[Envoy hash](#ref-envoy-consistent-hash)</sup>

consistent hashing은 sticky routing을 단순하게 만들고 싶을 때 떠올릴 수 있는 도구다. 별도의 session map을 저장하지 않아도 같은 key를 hash하면 대체로 같은 backend가 나오기 때문이다. cache server를 고를 때도 자주 쓰이는 패턴이고, LLM serving에서도 conversation id나 prefix hash를 worker 선택 key로 사용할 수 있다.

일반 웹 예:

```text
hash(user_id) -> server
hash(session_id) -> server
```

LLM 예:

```text
hash(conversation_id) -> worker
hash(prefix_hash) -> worker
hash(tenant_id, model_id) -> worker pool
```

장점:

- sticky routing을 단순하게 구현할 수 있다.
- 중앙 session map 없이도 같은 key가 같은 worker로 갈 가능성이 높다.
- scale out/in 때 전체 cache가 한 번에 무효화되지 않는다.

단점:

- worker load를 실시간 반영하기 어렵다.
- 긴 요청이 몰리는 key가 있으면 hot spot이 생긴다.
- worker가 죽으면 해당 key들의 cache locality가 사라진다.
- LLM에서는 "같은 key"보다 "비슷한 prefix"가 중요할 때도 있다.

Envoy 문서는 ring hash와 Maglev 같은 consistent hashing load balancer를 제공하며, backend 변경 시 일부 request만 이동하도록 하는 특성을 설명한다. 다만 hash 기반 stickiness는 host set이 변하면 upstream host가 바뀔 수 있어 "weak stickiness"로 볼 수 있다.<sup>[Envoy hash](#ref-envoy-consistent-hash)</sup> <sup>[Envoy stateful session](#ref-envoy-stateful-session)</sup>

LLM serving에서 consistent hashing을 쓸 때는 "간단한 locality"와 "실시간 부하 반영" 사이의 한계를 이해해야 한다. hash 결과가 Worker A라고 해서 Worker A가 지금 좋은 선택이라는 보장은 없다. Worker A가 긴 decode 요청들로 가득 차 있거나 KV memory가 거의 찼을 수도 있다. 그래서 consistent hashing은 단독 해법이라기보다, 후보 worker를 좁히는 첫 단계로 쓰고 이후 load/SLO/cache 상태를 함께 보는 방식이 더 현실적이다.

---

## 11. 장애가 나면 어떻게 될까?

### 11.1 일반 stateless API server 장애

```text
Server 1 down
Load balancer removes Server 1
Next request goes to Server 2
Server 2 reads DB/Redis
```

stateless API server에서는 장애의 의미가 비교적 단순하다. 현재 처리 중이던 요청 몇 개는 실패할 수 있지만, 다음 요청은 다른 서버가 처리하면 된다. 서버 내부에 반드시 보존해야 하는 사용자 상태가 없기 때문이다. 그래서 health check, connection draining, retry, autoscaling 같은 일반적인 운영 기법이 잘 맞는다.

사용자는 큰 문제를 못 느낄 수 있다.

### 11.2 LLM worker 장애

```text
Worker 1 down
Worker 1 had:
  active generation state
  KV cache
  prefix cache
  scheduler queue
```

LLM worker 장애는 더 복잡하다. worker가 들고 있던 model weights는 다른 worker에도 있을 수 있지만, active generation의 KV cache와 scheduler state는 보통 그 worker에만 있다. streaming 중이었다면 client는 응답 중간에서 연결이 끊겼다고 느낄 수 있다. prefix cache가 사라지면 이후 요청은 correctness에는 문제가 없더라도 갑자기 느려질 수 있다.

영향:

- streaming 중이던 응답이 끊길 수 있다.
- active request는 재시도해야 할 수 있다.
- KV cache는 대부분 사라진다.
- prefix cache hit rate가 일시적으로 낮아진다.
- 같은 conversation의 다음 request가 느려질 수 있다.

### 11.3 복구 선택지

선택지 1: cache를 포기하고 재계산

```text
장점:
  단순하다.
  correctness가 쉽다.

단점:
  latency 증가
  GPU 비용 증가
```

선택지 2: KV cache replication

```text
장점:
  장애 시 빠른 failover 가능

단점:
  GPU memory와 bandwidth 비용이 매우 큼
  구현 복잡
```

선택지 3: prefix만 재사용 가능하게 설계

```text
장점:
  active decode state 전체 복제보다 현실적
  긴 prompt 반복 workload에 효과

단점:
  worker-local cache이면 여전히 장애에 취약
  distributed cache 설계가 어려움
```

대부분의 경우, active generation state는 강하게 복제하기보다 실패 시 재시도/재계산하는 쪽이 단순하고 현실적이다.  
다만 SLA, 비용, request 길이에 따라 달라진다.

여기서 "재시도하면 되지"도 단순한 말은 아니다. LLM generation은 sampling parameter에 따라 매번 다른 결과가 나올 수 있고, 이미 사용자에게 일부 token을 streaming했다면 처음부터 다시 생성했을 때 앞부분이 달라질 수 있다. 과금도 애매해진다. 실패 전까지 생성한 token을 과금할 것인지, 재시도 token을 무료로 볼 것인지 정책이 필요하다. 따라서 LLM worker 장애 복구는 infra 문제인 동시에 product semantics 문제이기도 하다.

---

## 12. Prefill/Decode 분리와 sticky session의 변화

DistServe는 prefill과 decode가 서로 다른 병목을 가진다는 점에 주목해 두 단계를 다른 GPU에 배치하는 방식을 제안한다.<sup>[DistServe](#ref-distserve)</sup>

prefill과 decode를 같은 GPU worker에서 처리하면 구현은 단순하지만, 두 종류의 작업이 서로를 방해할 수 있다. 긴 prompt prefill은 대량의 계산을 한 번에 요구하고, decode는 작은 step을 반복하면서 낮은 지연을 요구한다. 긴 prefill이 GPU를 오래 점유하면 이미 streaming 중인 요청들의 다음 token이 늦어질 수 있다. 반대로 decode 요청이 많으면 새 요청의 prefill이 밀려 첫 token이 늦어질 수 있다.

```text
Client request
   |
   v
Prefill GPU pool
   |
   | KV transfer
   v
Decode GPU pool
   |
   v
Streaming response
```

이 구조에서는 sticky session의 질문이 더 복잡해진다.

기존 질문:

```text
이 conversation을 어느 worker에 붙일까?
```

분리 후 질문:

```text
prefill은 어느 GPU pool에서 할까?
decode는 어느 GPU worker에서 이어갈까?
prefill 결과 KV cache를 어떻게 decode worker로 보낼까?
decode worker에 이후 token state를 계속 붙일까?
prefix cache는 prefill pool에 둘까, decode pool에 둘까?
```

DistServe류 구조는 prefill/decode 간 interference를 줄일 수 있지만, KV 이동과 네트워크 bandwidth라는 새 비용을 만든다.<sup>[DistServe](#ref-distserve)</sup>

이 구조는 마치 백엔드에서 read-heavy workload와 write-heavy workload를 다른 pool로 분리하는 것과 비슷한 면이 있다. 각 pool을 자기 병목에 맞게 튜닝할 수 있기 때문이다. 하지만 prefill 결과로 생긴 KV cache를 decode pool로 넘겨야 하므로, pool을 나누는 순간 데이터 이동 문제가 생긴다. GPU 간, 노드 간 bandwidth가 충분하지 않으면 분리의 이득이 KV transfer 비용에 먹힐 수 있다.

---

## 13. Chunked prefill과 scheduling

Sarathi-Serve는 긴 prefill을 작은 chunk로 나눠 decode와 함께 스케줄링하는 접근을 제안한다.<sup>[Sarathi-Serve](#ref-sarathi)</sup>

chunked prefill의 직관은 "큰 일을 한 번에 몰아서 하지 말고, 작은 조각으로 나눠 다른 중요한 일과 섞자"는 것이다. 백엔드 개발에서 오래 걸리는 CPU 작업을 event loop에서 그대로 실행하면 다른 요청이 막히는 것과 비슷하다. 긴 prefill을 작은 chunk로 나누면 decode 요청들이 다음 token을 받을 기회를 더 자주 얻을 수 있고, streaming 응답의 끊김을 줄일 수 있다.

문제 상황:

```text
긴 prompt prefill 하나가 GPU를 오래 잡고 있으면
이미 decode 중인 요청들의 다음 token 생성이 밀린다.
사용자는 streaming이 끊기는 것처럼 느낄 수 있다.
```

아이디어:

```text
긴 prefill을 chunk로 쪼갠다.
decode 작업 사이사이에 prefill chunk를 섞는다.
```

백엔드 관점으로 비유하면:

```text
큰 작업 하나가 event loop를 오래 막지 않게 쪼개서 cooperative scheduling하는 것
```

이 주제는 sticky session과 직접 연결된다.

- 같은 worker에 붙인다고 항상 빠른 것은 아니다.
- 그 worker에서 긴 prefill이 돌아가면 decode latency가 나빠질 수 있다.
- router와 scheduler가 함께 설계되어야 한다.

결국 sticky session은 routing 문제처럼 보이지만, LLM에서는 scheduling 문제와 분리하기 어렵다. router가 cache가 있는 worker를 잘 골랐더라도, 그 worker의 scheduler가 긴 prefill을 어떻게 다루느냐에 따라 실제 latency가 달라진다. 반대로 scheduler가 훌륭해도 router가 cache locality를 전혀 고려하지 않으면 prefill 비용이 계속 반복된다. LLM serving에서는 router와 scheduler가 함께 하나의 제어 루프를 이룬다고 보는 편이 좋다.

---

## 14. LLM load balancer가 봐야 하는 지표

일반 L7 load balancer:

```text
requests per second
active connections
HTTP latency
error rate
```

LLM-aware router/scheduler:

```text
Input-related:
  prompt_tokens
  prefix_hash
  prefix_cache_hit_estimate
  model_id
  tokenizer_id
  adapter_id

Output-related:
  max_tokens
  expected_output_tokens
  sampling params
  streaming 여부

Worker load:
  active_sequences
  waiting_prefills
  waiting_decodes
  running_batch_size
  GPU utilization
  KV cache memory usage
  cache block free count

SLO:
  TTFT target
  TPOT target
  request timeout
  tenant priority

Reliability:
  recent OOM count
  timeout rate
  health status
  warm/cold model state
```

중요한 것은 LLM에서 "부하"는 단일 숫자로 표현하기 어렵다는 점이다.

일반 웹 서비스에서도 좋은 observability가 중요하지만, LLM serving에서는 특히 어떤 지표를 보느냐가 설계 판단을 크게 바꾼다. 예를 들어 GPU utilization이 높다고 해서 항상 나쁜 것은 아니다. throughput 관점에서는 GPU를 잘 쓰고 있다는 뜻일 수 있다. 하지만 동시에 p99 TTFT가 나빠지고 있다면 queueing이 과도하다는 신호일 수 있다. KV cache usage가 높아도 cache hit로 성능이 좋아지는 중일 수 있고, 반대로 eviction이 잦아 cache thrashing이 발생하고 있을 수도 있다.

따라서 LLM router의 metric은 "현재 한가한가"를 묻는 단일 질문이 아니라, "이 요청을 이 worker에 보냈을 때 cache 이득이 queue 비용보다 큰가", "이 tenant의 SLO를 지킬 수 있는가", "이 선택이 다른 active sequence의 decode latency를 망치지 않는가" 같은 질문에 답할 수 있어야 한다.

---

## 15. 설계 패턴

이제 앞에서 배운 개념을 실제 architecture 패턴으로 묶어보자. 중요한 것은 어떤 패턴이 항상 더 좋다고 외우는 것이 아니라, traffic 규모와 workload 특성에 따라 어느 정도의 복잡도를 감당할지 판단하는 것이다. 초기 서비스라면 단순한 Kubernetes Service 뒤에 vLLM replica 몇 개를 두는 구조가 충분할 수 있다. 반면 긴 문서 QA나 multi-tenant enterprise workload처럼 prefix reuse와 SLO가 중요한 서비스라면 cache-aware routing이나 prefill/decode 분리까지 고려해야 한다.

### 15.1 가장 단순한 구조

```text
Client
  |
API Gateway
  |
Kubernetes Service
  |
vLLM Replica 1
vLLM Replica 2
vLLM Replica 3
```

장점:

- 운영이 쉽다.
- 일반적인 Kubernetes 패턴과 잘 맞는다.
- 시작하기 좋다.

단점:

- prefix cache locality를 활용하기 어렵다.
- request cost 차이를 잘 반영하지 못한다.
- long request가 특정 replica에 쌓일 수 있다.

이 구조는 실험, 내부 도구, 초기 product validation에는 좋은 출발점이다. 운영팀 입장에서도 익숙한 Kubernetes 배포와 health check, autoscaling 패턴을 그대로 쓸 수 있다. 하지만 LLM traffic이 커지면 곧 한계가 보인다. 어떤 replica는 긴 prompt 몇 개 때문에 queue가 길어지고, 다른 replica는 상대적으로 한가할 수 있다. 또 같은 긴 문서가 반복 요청되어도 매번 다른 replica로 가면 prefix cache hit 기회를 놓칠 수 있다.

### 15.2 Session affinity 추가

```text
Client
  |
Ingress / LB with session affinity
  |
vLLM Replica pool
```

장점:

- 같은 user/conversation이 같은 replica로 갈 가능성이 높다.
- multi-turn conversation에서 cache hit 가능성이 올라간다.

단점:

- IP 기반 affinity는 정확하지 않을 수 있다.
- user 단위 stickiness는 LLM 비용과 잘 맞지 않을 수 있다.
- hot user가 hot worker를 만든다.

session affinity를 추가하면 multi-turn chat처럼 같은 사용자가 같은 대화를 이어가는 workload에서는 어느 정도 이득이 있다. 하지만 이 방식은 "사용자"와 "계산 재사용 가능성"이 잘 맞는다는 가정에 기대고 있다. 실제로는 같은 사용자가 완전히 다른 문서를 번갈아 질문할 수도 있고, 서로 다른 사용자가 같은 문서에 대해 질문할 수도 있다. 그래서 일반적인 sticky session은 LLM 최적화의 출발점일 수는 있지만, 정교한 해법은 아니다.

### 15.3 Prefix-aware router

```text
Client
  |
API Gateway
  |
LLM Router
  |-- computes prefix hash
  |-- reads worker load/cache metadata
  |
vLLM Replica pool
```

장점:

- cache hit와 load balance를 함께 고려할 수 있다.
- 긴 공통 문서, RAG, multi-round chat에 유리하다.

단점:

- router가 LLM-specific해진다.
- metadata 관리가 필요하다.
- cache hit 최적화와 fairness가 충돌할 수 있다.

prefix-aware router는 LLM serving이 일반 웹 serving과 달라지는 지점이 가장 잘 드러나는 패턴이다. router가 더 이상 HTTP method, path, header 정도만 보는 것이 아니라 prompt의 token prefix, model id, adapter id, cache state를 고려한다. 이 설계는 성능을 크게 개선할 수 있지만, 그만큼 router가 inference engine 내부 동작에 가까워진다. 따라서 model serving framework, tokenizer version, cache eviction policy가 router와 맞물리게 되고, 운영 복잡도도 함께 올라간다.

### 15.4 Prefill/decode disaggregation

```text
Client
  |
Router
  |
Prefill Pool
  |
KV transfer
  |
Decode Pool
```

장점:

- prefill과 decode의 병목을 따로 최적화할 수 있다.
- TTFT와 TPOT SLO를 분리해서 다룰 수 있다.

단점:

- KV transfer 비용이 생긴다.
- scheduling과 placement가 복잡하다.
- network topology가 중요해진다.

prefill/decode disaggregation은 대규모 serving에서 매력적인 패턴이지만, 처음부터 도입하기에는 무겁다. 두 pool을 나누면 각 pool의 GPU 수, parallelism 전략, placement, network bandwidth를 따로 최적화해야 한다. 특히 prefill worker가 만든 KV cache를 decode worker가 제때 받아야 하므로, 단순히 "계산을 나눴다"가 아니라 "중간 상태를 빠르게 전달하는 pipeline을 만들었다"에 가깝다. 이 구조는 SLO가 빡빡하고 traffic이 충분히 커서 복잡도를 정당화할 수 있을 때 검토하는 편이 자연스럽다.

---

## 16. Sticky session을 쓸지 말지 판단하는 질문

sticky session은 켜고 끄는 설정처럼 보이지만, 실제로는 state를 어디에 둘지에 대한 설계 결정이다. 따라서 질문은 "sticky session이 좋은가 나쁜가"가 아니라 "붙잡고 싶은 state가 무엇이고, 그것을 붙잡는 비용을 감당할 수 있는가"가 되어야 한다.

### 16.1 일반 백엔드 질문

```text
서버 로컬 상태가 꼭 필요한가?
그 상태를 Redis/DB로 빼면 안 되는가?
서버 장애 시 상태를 잃어도 되는가?
특정 사용자가 특정 서버에 몰려도 괜찮은가?
배포/스케일링 때 세션 이동을 어떻게 처리할 것인가?
```

일반 백엔드에서는 이 질문들에 답하다 보면 대개 상태 외부화 쪽으로 생각이 흐른다. 로그인 세션은 Redis로, 영구 데이터는 DB로, 비동기 작업 상태는 queue나 durable store로 옮기는 식이다. 이렇게 하면 애플리케이션 서버는 장애가 나도 쉽게 교체할 수 있고, load balancer는 더 자유롭게 요청을 분산할 수 있다.

### 16.2 LLM inference 질문

```text
어떤 상태를 붙잡고 싶은가?
  active sequence KV cache?
  prefix cache?
  conversation history?
  loaded model weights?
  LoRA adapter?

그 상태는 어디에 있는가?
  GPU memory?
  CPU memory?
  remote cache?
  object storage?

cache hit의 이득은 얼마나 큰가?
  prefill token이 긴가?
  같은 prefix가 자주 반복되는가?
  output이 길어서 decode가 지배적인가?

stickiness의 비용은 무엇인가?
  hot spot?
  queueing delay?
  fairness 저하?
  failover 어려움?

대안은 무엇인가?
  prefix-aware routing?
  consistent hashing?
  cache replication?
  cache recomputation?
  prefill/decode 분리?
```

LLM inference에서는 같은 질문이 더 미묘해진다. KV cache를 완전히 외부화하면 stateless에 가까워질 수는 있지만, GPU memory locality를 잃어 성능이 나빠질 수 있다. 반대로 worker-local cache에 강하게 의존하면 성능은 좋아질 수 있지만 failover와 load balancing이 어려워진다. 그래서 "항상 sticky"나 "절대 sticky 금지" 같은 규칙보다, cache hit로 얻는 이득과 queue imbalance로 잃는 비용을 비교하는 사고방식이 필요하다.

---

## 17. 예제 시나리오로 이해하기

이 장에서는 같은 개념이 workload에 따라 어떻게 다르게 적용되는지 살펴본다. 시스템 디자인 면접에서도 좋은 답변은 특정 기술을 나열하는 것이 아니라, 요구사항과 traffic shape를 보고 적절한 trade-off를 선택하는 데서 나온다. LLM inference도 마찬가지다. 어떤 서비스는 prefix cache가 핵심이고, 어떤 서비스는 decode throughput이 핵심이며, 어떤 서비스는 tenant isolation이 가장 중요할 수 있다.

### 17.1 고객지원 챗봇

특징:

- multi-turn conversation 많음
- 이전 대화 문맥 재사용 가능
- 사용자마다 요청 빈도 차이 큼

고려:

- conversation 단위 routing이 유리할 수 있다.
- 하지만 heavy user가 hot spot을 만들 수 있다.
- conversation history가 길어지면 prompt compaction/summarization도 필요하다.

추천 설계:

```text
conversation_id 기반 soft affinity
worker load가 심하면 다른 worker로 보내고 prefix 재계산 허용
prefix cache hit rate와 queue delay를 함께 본다
```

고객지원 챗봇은 sticky session을 가장 먼저 떠올리기 쉬운 사례다. 사용자는 같은 상담 흐름 안에서 여러 번 질문하고, 매 요청은 이전 대화 history를 포함할 가능성이 높다. 따라서 conversation_id를 기준으로 같은 worker에 보내면 prefix cache를 재사용할 수 있다. 다만 고객마다 대화 길이와 요청 빈도가 다르기 때문에 hard affinity를 걸면 특정 worker에 긴 대화가 몰릴 수 있다. 그래서 "가능하면 같은 worker, 너무 바쁘면 다른 worker"라는 soft affinity가 더 현실적인 선택이 될 수 있다.

### 17.2 긴 문서 QA

특징:

- 같은 긴 문서를 두고 여러 질문
- input token이 매우 큼
- output은 상대적으로 짧을 수 있음

고려:

- prefix caching 효과가 매우 크다.
- user 단위보다 document/prefix 단위 routing이 중요하다.
- tenant isolation과 cache salt가 중요하다.

추천 설계:

```text
document chunk/prefix hash 기반 routing
prefix cache hit 우선
동일 tenant 안에서만 cache reuse
긴 문서 prefill은 chunking 고려
```

긴 문서 QA는 prefix caching의 효과가 가장 직관적으로 드러나는 workload다. 사용자가 질문을 바꿔도 문서 본문은 그대로 유지되는 경우가 많기 때문이다. 이때 user_id보다 document_id나 prefix hash가 더 좋은 routing key가 된다. 하지만 기업 고객의 문서라면 tenant isolation이 매우 중요하다. 같은 문서 내용이 우연히 다른 tenant에도 있더라도 cache를 공유하면 안 되는 정책이 필요할 수 있다. 성능 최적화보다 데이터 경계가 우선인 경우가 많다.

### 17.3 코드 생성 에이전트

특징:

- 긴 context
- output도 길 수 있음
- tool call, retry, streaming 많음

고려:

- prefill과 decode 둘 다 무겁다.
- streaming 중 failover가 어렵다.
- request timeout과 partial output 처리가 중요하다.

추천 설계:

```text
active generation은 worker-local state로 보고 강한 failover를 포기
실패 시 client/app layer에서 재시도
긴 context prefix cache 활용
tenant/project 단위 cache isolation
```

코드 생성 에이전트는 prompt도 길고 output도 길 수 있어 prefill과 decode가 모두 부담이 된다. 게다가 tool call이나 파일 context, retry가 섞이면 같은 request가 단순한 한 번의 completion이 아니라 긴 workflow가 된다. 이 경우 active generation을 중간부터 완벽하게 failover하려고 하면 구현 복잡도가 매우 커진다. 대신 중간 실패를 application layer에서 감지하고, 필요한 context를 다시 구성해 재시도하는 편이 더 단순할 수 있다.

### 17.4 Batch embedding

특징:

- autoregressive decode 없음
- KV cache 중요도 낮음
- throughput 중심

고려:

- sticky session은 거의 필요 없다.
- dynamic batching과 queue management가 더 중요하다.
- chat serving과 resource pool을 분리해야 한다.

추천 설계:

```text
chat GPU pool과 embedding GPU pool 분리
bulkhead 적용
batch queue 기반 scheduling
```

batch embedding은 chat completion과 다른 성격을 가진다. autoregressive decode가 없으므로 KV cache locality나 sticky session의 중요도가 낮다. 대신 많은 입력을 효율적으로 묶어 처리하는 batching과 queue 관리가 중요하다. 특히 embedding 대량 작업이 chat serving GPU를 잠식하면 사용자-facing latency가 나빠질 수 있으므로, resource pool을 분리하는 bulkhead 설계가 중요하다.

---

## 18. 흔한 오해

이 장의 목적은 용어를 외울 때 생기기 쉬운 단순화를 바로잡는 것이다. 시스템 디자인에서는 "A는 좋고 B는 나쁘다"보다 "어떤 조건에서 A가 좋아지고, 어떤 비용을 치르는가"가 더 중요하다.

### 오해 1. "Sticky session은 나쁜 패턴이다"

아니다.  
Sticky session은 local state를 활용하기 위한 도구다. 일반 웹에서는 state externalization이 더 나은 경우가 많지만, LLM inference에서는 local GPU state가 성능에 매우 중요하다.

정확한 표현:

```text
Sticky session은 부하 분산과 장애 복구를 어렵게 만들 수 있으므로,
local state 재사용 이득이 그 비용보다 클 때 선택한다.
```

즉 sticky session은 smell일 수도 있고 optimization일 수도 있다. 로그인 세션을 서버 메모리에 두기 위해 sticky session을 쓰는 것은 장기적으로 부담이 될 가능성이 크다. 반면 GPU worker의 KV cache locality를 활용하기 위해 soft affinity를 두는 것은 합리적인 최적화일 수 있다. 같은 기술도 맥락에 따라 평가가 달라진다.

### 오해 2. "KV cache는 Redis 같은 cache다"

아니다.  
KV cache는 model execution 중 생기는 GPU tensor state다. Redis cache처럼 편하게 직렬화해서 네트워크로 주고받는 데이터로 보면 안 된다.

이 오해는 "cache"라는 단어가 너무 익숙하기 때문에 생긴다. 백엔드 엔지니어에게 cache는 흔히 key-value store, TTL, eviction policy, serialization을 떠올리게 한다. KV cache에도 key와 eviction이 있을 수 있지만, 본질은 모델 내부 계산 결과를 GPU memory에 잡아두는 것이다. Redis cache와 같은 mental model로 접근하면 이동 비용과 latency 요구사항을 과소평가하게 된다.

### 오해 3. "같은 사용자는 항상 같은 GPU로 보내면 된다"

항상 그렇지 않다.  
LLM 비용은 user보다 prompt, output length, prefix reuse, 현재 queue 상태에 더 민감할 수 있다.

사용자 단위 stickiness는 구현이 쉽지만 너무 거칠다. 한 사용자가 짧은 요청과 긴 요청을 섞어 보낼 수 있고, 한 기업 tenant 안의 여러 사용자가 같은 문서를 공유할 수도 있다. LLM에서는 "같은 사용자"보다 "같은 계산을 재사용할 수 있는가"가 더 직접적인 기준이다.

### 오해 4. "로드 밸런싱은 Kubernetes Service가 알아서 해준다"

초기에는 가능하다.<sup>[K8s](#ref-k8s-session)</sup>  
하지만 LLM serving에서 성능을 끌어올리려면 request cost, KV cache locality, worker queue, prefix cache hit를 이해하는 LLM-aware router가 필요해진다.

Kubernetes Service는 범용적인 service discovery와 load balancing을 제공한다. 하지만 LLM request의 token length나 prefix cache hit 가능성은 알지 못한다. 그래서 traffic이 작을 때는 충분할 수 있지만, 성능 최적화가 중요해지면 domain-specific routing이 필요해진다. 이때부터는 platform load balancer와 inference scheduler의 책임 경계를 명확히 해야 한다.

### 오해 5. "Cache hit만 높이면 된다"

아니다.  
Cache hit를 위해 너무 바쁜 worker에 계속 보내면 tail latency가 나빠질 수 있다.

cache hit rate는 좋은 지표지만 목적 함수 그 자체는 아니다. 사용자가 원하는 것은 빠르고 안정적인 응답이고, 운영자가 원하는 것은 SLO 안에서 GPU를 효율적으로 쓰는 것이다. cache hit를 높이느라 특정 worker queue가 길어지면 p99 latency가 나빠질 수 있다. 따라서 cache hit rate는 TTFT, TPOT, queueing delay, eviction rate와 함께 해석해야 한다.

---

## 19. 관찰해야 할 메트릭

LLM serving을 운영할 때는 "무엇을 관찰할 것인가"가 설계만큼 중요하다. 잘못된 지표를 보면 잘못된 최적화를 하게 된다. 예를 들어 request throughput만 보고 autoscaling하면 긴 prompt가 몰리는 상황을 놓칠 수 있고, GPU utilization만 보면 사용자가 첫 token을 오래 기다리는 문제를 놓칠 수 있다.

### 19.1 Router 메트릭

```text
route_decision_total{reason="prefix_hit"}
route_decision_total{reason="least_loaded"}
route_decision_total{reason="fallback"}
cache_affinity_bypassed_total
router_metadata_staleness_ms
```

router metric은 "왜 이 worker를 선택했는가"를 설명할 수 있어야 한다. 장애나 latency spike가 발생했을 때, 단순히 어느 worker가 느렸는지만 알면 부족하다. router가 cache hit를 우선했는지, load balance를 우선했는지, metadata가 없어서 fallback했는지를 알아야 다음 개선 방향이 보인다.

### 19.2 Worker 메트릭

```text
active_sequences
waiting_prefill_queue_size
waiting_decode_queue_size
kv_cache_usage_bytes
kv_cache_usage_ratio
kv_cache_evictions_total
prefix_cache_hit_total
prefix_cache_miss_total
gpu_utilization
gpu_memory_used_bytes
```

worker metric은 GPU 내부에서 무슨 일이 벌어지는지 보여준다. 특히 KV cache usage와 eviction은 함께 봐야 한다. cache usage가 높아도 eviction이 적고 hit rate가 높다면 효율적으로 쓰고 있을 수 있다. 반대로 usage가 계속 95% 이상이고 eviction이 급증한다면 cache thrashing으로 인해 prefill 재계산이 늘어날 수 있다.

### 19.3 사용자 경험 메트릭

```text
ttft_p50 / p90 / p99
tpot_p50 / p90 / p99
e2e_latency_p50 / p90 / p99
tokens_per_second
stream_interruption_total
request_timeout_total
```

사용자 경험 metric은 결국 product 품질과 연결된다. LLM 서비스에서는 평균 latency보다 p90, p99가 더 중요할 때가 많다. 대부분의 요청은 빠르지만 일부 긴 요청이 queue를 막아 tail latency가 나빠지면 사용자는 서비스를 불안정하게 느낀다. 특히 streaming에서는 TTFT와 TPOT를 나누어 봐야 "처음 시작이 느린 문제"인지 "생성 중간중간 끊기는 문제"인지 구분할 수 있다.

### 19.4 운영 메트릭

```text
oom_total
worker_restart_total
model_load_time_seconds
cold_start_total
fallback_model_total
tenant_throttled_total
```

운영 metric은 시스템이 정상 상태를 유지하고 있는지 알려준다. OOM이 늘어나면 KV cache sizing이나 max token 제한을 다시 봐야 하고, worker restart가 늘어나면 cache hit rate가 떨어지는 부작용도 함께 발생할 수 있다. fallback model이 자주 쓰인다면 primary model pool capacity가 부족하거나 circuit breaker threshold가 너무 민감할 수 있다.

---

## 20. 간단한 라우팅 의사코드

실제 구현은 훨씬 복잡하지만, 사고방식을 익히기 위한 의사코드다.

```python
def choose_worker(request, workers):
    candidates = workers.for_model(request.model_id)
    healthy = [w for w in candidates if w.healthy]

    prefix_key = compute_prefix_hash(request)
    cache_hit_workers = [w for w in healthy if w.has_prefix(prefix_key)]

    if cache_hit_workers:
        best_cache_worker = min(cache_hit_workers, key=estimated_queue_delay)
        best_any_worker = min(healthy, key=estimated_total_load)

        saved_prefill_ms = estimate_prefill_saving(request, best_cache_worker)
        extra_queue_ms = (
            estimated_queue_delay(best_cache_worker)
            - estimated_queue_delay(best_any_worker)
        )

        if saved_prefill_ms > extra_queue_ms:
            return best_cache_worker

    return min(healthy, key=estimated_total_load)
```

이 의사코드가 말하는 핵심:

```text
cache hit worker를 무조건 고르지 않는다.
cache로 절약하는 시간과 queue에서 잃는 시간을 비교한다.
```

이 코드는 production-ready router가 아니라 사고 훈련용이다. 실제 시스템에서는 estimated_queue_delay와 estimate_prefill_saving을 정확히 계산하기 어렵다. prompt token 수, cache block hit 비율, 현재 batch 상태, worker별 throughput, tenant priority, timeout 등을 모두 고려해야 한다. 그래도 핵심 구조는 유효하다. 먼저 cache locality 후보를 찾고, 그 후보가 현재 load 상황에서도 좋은 선택인지 비교한 뒤, 이득이 충분하지 않으면 더 한가한 worker로 보내는 것이다.

---

## 21. 1년차 백엔드 엔지니어를 위한 학습 순서

처음부터 PagedAttention 논문이나 prefill/decode disaggregation을 읽으면 추상적으로 느껴질 수 있다. 먼저 일반 백엔드의 state 관리와 load balancing을 단단히 잡고, 그 다음 LLM inference에서 어떤 가정이 깨지는지 보는 순서가 좋다. 아래 순서는 "이미 아는 웹 백엔드 개념에서 출발해 LLM serving으로 이동하는 길"로 설계했다.

### Step 1. 일반 웹 sticky session을 이해한다

공부할 것:

- L4 vs L7 load balancing
- IP hash
- cookie-based stickiness
- session store externalization
- stateless API server

질문:

```text
왜 로그인 세션을 서버 memory에 두면 scale out이 어려울까?
왜 Redis로 세션을 빼면 sticky session이 덜 필요할까?
IP 기반 affinity는 왜 NAT 환경에서 위험할까?
```

이 단계에서는 Kubernetes, NGINX, Envoy 문서를 보면서 session affinity가 실제 설정으로 어떻게 표현되는지 확인하면 좋다. 중요한 것은 설정법 자체보다, 각 방식이 어떤 key를 기준으로 stickiness를 만드는지 이해하는 것이다. IP 기반인지, cookie 기반인지, header 기반인지에 따라 장애와 보안 특성이 달라진다.

### Step 2. LLM inference의 prefill/decode를 이해한다

공부할 것:

- autoregressive generation
- token
- prefill
- decode
- TTFT
- TPOT

질문:

```text
input token이 길면 어느 단계가 느려질까?
output token이 길면 어느 단계가 느려질까?
streaming 응답에서 사용자가 체감하는 지연은 무엇일까?
```

이 단계에서는 LLM API를 사용할 때도 응답 전체 시간만 보지 말고 첫 token이 언제 나오는지, 이후 token이 얼마나 규칙적으로 나오는지 관찰해보면 좋다. 같은 총 latency라도 첫 token이 빨리 나오면 사용자는 더 빠르게 느낄 수 있다. 반대로 첫 token은 빨라도 중간 token 간격이 들쭉날쭉하면 streaming 품질이 나빠 보인다.

### Step 3. KV cache를 이해한다

공부할 것:

- attention key/value
- KV cache memory growth
- GPU memory bottleneck
- cache block/page
- prefix caching

질문:

```text
KV cache는 왜 요청 길이에 따라 커질까?
KV cache는 왜 worker local state로 보는가?
Redis cache와 무엇이 다른가?
```

이 단계에서는 "KV cache는 어디에 저장되는가", "sequence가 끝나면 cache는 어떻게 되는가", "같은 prefix를 어떻게 판별하는가"를 중심으로 보면 좋다. vLLM의 prefix caching 문서를 함께 보면 cache block, hash, eviction 같은 단어가 일반 cache와 비슷하면서도 GPU serving 맥락에서는 다르게 쓰인다는 감각이 생긴다.

### Step 4. LLM-aware load balancing을 이해한다

공부할 것:

- active sequence
- continuous batching
- prefix-aware routing
- request cost estimation
- cache locality vs load balancing

질문:

```text
least connections가 LLM serving에서 부족한 이유는?
cache hit worker가 바쁘면 어떻게 결정할까?
prefix cache hit rate와 p99 latency가 동시에 좋아질 수 있을까?
```

이 단계에서는 단순한 load balancer와 LLM-aware router의 차이를 직접 말로 설명할 수 있어야 한다. "least connections로는 왜 부족한가", "cache hit worker가 항상 정답이 아닌 이유는 무엇인가", "worker가 보고해야 할 metric은 무엇인가" 같은 질문에 답해보면 좋다.

### Step 5. 고급 구조를 본다

공부할 것:

- iteration-level scheduling
- chunked prefill
- prefill/decode disaggregation
- KV transfer
- multi-tenant cache isolation

질문:

```text
prefill과 decode를 분리하면 어떤 비용이 새로 생길까?
긴 prompt가 짧은 decode 요청을 방해하지 않게 하려면?
tenant 간 cache reuse를 막아야 하는 이유는?
```

마지막 단계에서는 논문을 읽을 때 모든 수식과 구현 세부사항을 처음부터 완벽히 이해하려고 하기보다, 각 논문이 어떤 병목을 해결하려는지에 집중하면 좋다. Orca는 iteration-level scheduling, PagedAttention은 KV memory management, DistServe는 prefill/decode interference, Sarathi-Serve는 chunked prefill과 stall-free scheduling이라는 식으로 "문제-해법"의 짝을 잡아두면 이후 세부사항을 읽기가 훨씬 쉬워진다.

---

## 22. 토론 문제

아래 문제들은 정답을 하나로 고르기 위한 문제가 아니다. 스터디에서는 각자 어떤 metric을 보고 어떤 trade-off를 선택할지 말해보는 방식이 좋다. 특히 "왜 그렇게 라우팅하는가", "장애가 났을 때 사용자는 무엇을 보게 되는가", "보안 경계는 어디인가"를 함께 이야기하면 시스템 디자인 감각을 키우는 데 도움이 된다.

### 문제 1

사용자가 같은 고객지원 챗봇과 20턴 대화를 이어가고 있다. 매 턴마다 전체 대화 history를 prompt에 포함한다.

질문:

```text
conversation_id 기반 sticky routing을 적용해야 할까?
worker가 바쁘면 다른 worker로 보내도 될까?
prefix caching은 어느 정도 도움이 될까?
```

생각할 포인트:

- multi-turn history는 prefix reuse 가능성이 높다.
- 하지만 output이 길면 decode가 지배적일 수 있다.
- cache hit보다 queue delay가 클 수 있다.

### 문제 2

기업 고객이 300페이지 문서를 업로드하고, 사내 사용자 수십 명이 같은 문서에 대해 질문한다.

질문:

```text
user_id, document_id, prefix_hash 중 무엇으로 routing할까?
tenant isolation은 어떻게 할까?
cache hit를 높이기 위해 어떤 메트릭을 볼까?
```

생각할 포인트:

- document prefix가 핵심이다.
- 같은 tenant 안에서만 cache reuse해야 한다.
- prefix cache hit rate, TTFT, KV memory usage를 함께 본다.

### 문제 3

특정 worker가 어떤 prefix cache를 가지고 있지만 queue가 길다. 다른 worker는 cache가 없지만 한가하다.

질문:

```text
어느 worker로 보내야 할까?
어떤 정보를 알아야 더 정확히 결정할 수 있을까?
```

생각할 포인트:

- cache hit로 절약되는 prefill time
- queueing delay 차이
- prompt length
- expected output length
- SLO

### 문제 4

LLM worker가 streaming 중 죽었다.

질문:

```text
중간부터 이어서 생성해야 할까?
처음부터 재시도해야 할까?
사용자에게 partial output을 보여줘도 될까?
과금은 어떻게 처리할까?
```

생각할 포인트:

- active KV cache 복제 비용
- idempotency
- partial response semantics
- retry token budget

---

## 23. 이번 주차 개념과의 연결 지도

| 1주차 개념 | 일반 시스템 의미 | LLM inference 연결 |
|---|---|---|
| 수평 확장 | 서버 instance를 늘림 | GPU worker/model replica를 늘림 |
| 수직 확장 | 더 큰 서버 사용 | 더 큰 GPU, 더 많은 VRAM |
| 상태 비저장 서비스 | 아무 서버나 요청 처리 | API gateway/router는 stateless 지향 |
| 상태 저장 서비스 | 서버 내부 상태 유지 | GPU worker의 KV cache/scheduler state |
| 로드 밸런싱 | backend 선택 | model/prefix/load/SLO-aware routing |
| 고정 세션 | 같은 session을 같은 backend로 | 같은 sequence/prefix를 같은 worker로 |
| 세션 복제 | 상태를 여러 서버에 복제 | KV cache replication은 비싸고 어려움 |
| 분산 캐시 | read 성능 향상 | prefix cache, KV block reuse |
| 조정 서비스 | metadata/leader/discovery | worker health, model placement, session map |
| 가용성 | 장애에도 응답 | fallback model, retry, cache miss 재계산 |
| 벌크헤드 | 장애 격리 | chat/embedding/batch GPU pool 분리 |
| 서킷 브레이커 | 실패 반복 차단 | OOM worker/model pool routing 제외 |
| 지수 백오프 | 재시도 폭주 방지 | overloaded LLM endpoint retry 제어 |
| 성능/지연 | latency/throughput | TTFT, TPOT, tokens/sec, goodput |
| 일관성 | 같은 데이터 관점 | model version, tokenizer, cache key 일관성 |

---

## 24. 요약

Sticky session, load balancing, statefulness는 LLM inference에서 다음처럼 재해석된다.

```text
Sticky session:
  같은 user를 같은 server로 보내는 기술
  ->
  같은 sequence/prefix/cache key를 같은 GPU worker로 보내
  KV cache locality를 얻는 기술

Load balancing:
  요청 수를 여러 서버에 나누는 기술
  ->
  request token cost, GPU memory, queue, cache hit, SLO를 함께 보는 scheduling 문제

Statefulness:
  확장을 어렵게 하는 서버 내부 상태
  ->
  LLM serving에서는 성능을 좌우하는 GPU-local execution state
```

가장 중요한 감각:

```text
일반 백엔드에서는 state를 밖으로 빼서 확장한다.
LLM inference에서는 비싼 state를 잘 붙잡아서 성능을 얻는다.
하지만 state를 붙잡을수록 load balancing과 failover는 어려워진다.
```

따라서 좋은 LLM inference architecture는 다음 균형을 잡는 일이다.

```text
cache locality
vs
load balance
vs
fault tolerance
vs
fairness
vs
security isolation
```

이 자료의 큰 흐름을 다시 말하면, LLM serving은 기존 백엔드 지식 위에 새로운 제약을 얹은 분야다. load balancer, cache, queue, statefulness 같은 단어는 그대로 등장하지만, 그 의미가 GPU memory와 autoregressive generation 때문에 달라진다. 일반 백엔드에서 익힌 "상태를 외부화하고 서버를 대체 가능하게 만든다"는 원칙은 여전히 중요하다. 다만 LLM inference에서는 모든 상태를 밖으로 빼는 것이 아니라, 어떤 상태는 worker local에 남겨 성능을 얻고, 그로 인해 생기는 부하 불균형과 장애 복구 문제를 scheduler와 router가 완화한다.

따라서 sticky session을 볼 때도 단순히 "나쁜 패턴"이라고 판단하기보다, 그 sticky가 무엇을 보존하려는지 물어야 한다. 로그인 세션을 보존하려는 것인지, KV cache locality를 보존하려는 것인지, tenant isolation을 보존하려는 것인지에 따라 답이 달라진다. 이 질문을 던질 수 있으면 LLM inference system을 훨씬 더 깊게 읽을 수 있다.

---

## 25. 참고자료와 각주

아래 자료는 가능하면 공식 문서나 학회/논문 원문을 우선했다. 블로그 글은 설명 보조자료로는 유용하지만, 이 문서의 각주에는 넣지 않았다.

<a id="ref-k8s-session"></a>

1. **Kubernetes session affinity**  
   Kubernetes 공식 문서, "Virtual IPs and Service Proxies - Session affinity". Kubernetes `Service`에서 `.spec.sessionAffinity: ClientIP`로 client IP 기반 session affinity를 설정할 수 있고, `.spec.sessionAffinityConfig.clientIP.timeoutSeconds`의 기본값이 10800초임을 설명한다.  
   https://kubernetes.io/docs/reference/networking/virtual-ips/

<a id="ref-nginx-session"></a>

2. **NGINX session persistence**  
   NGINX Gateway Fabric 공식 문서, "Session Persistence". `ip_hash` 기반 affinity와 cookie 기반 session persistence의 차이, shared IP/NAT/proxy 환경에서 IP 기반 affinity가 부정확해질 수 있는 한계를 설명한다.  
   https://docs.nginx.com/nginx-gateway-fabric/traffic-management/session-persistence/

<a id="ref-envoy-stateful-session"></a>

3. **Envoy stateful session**  
   Envoy 공식 문서, "Stateful session". Stateful session filter가 session state를 바탕으로 upstream host를 override할 수 있고, stateful session이 upstream 간 load imbalance와 보안/신뢰성 이슈를 만들 수 있음을 경고한다.  
   https://www.envoyproxy.io/docs/envoy/latest/configuration/http/http_filters/stateful_session_filter

<a id="ref-envoy-consistent-hash"></a>

4. **Envoy consistent hashing load balancers**  
   Envoy 공식 문서, "Supported load balancers". Ring hash와 Maglev load balancer가 consistent hashing을 제공하며, host set이 안정적일 때 endpoint selection이 consistent하고 host 추가/삭제 시 일부 key만 이동하는 특성을 설명한다.  
   https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/upstream/load_balancing/load_balancers

<a id="ref-triton-batching"></a>

5. **NVIDIA Triton scheduling and batching**  
   NVIDIA Triton Inference Server 공식 문서, "Scheduling And Batching". Dynamic batcher는 stateless model의 request를 동적으로 묶어 throughput을 높이는 데 쓰고, sequence batcher는 sequence request가 같은 model instance로 가야 하는 stateful model에 쓰는 것으로 설명한다.  
   https://docs.nvidia.com/deeplearning/triton-inference-server/archives/triton_inference_server_220/user-guide/docs/model_configuration.html

<a id="ref-orca"></a>

6. **Orca: iteration-level scheduling**  
   Gyeong-In Yu et al., "Orca: A Distributed Serving System for Transformer-Based Generative Models", OSDI 2022. Transformer generation model이 autoregressive하게 다음 token을 생성하기 위해 여러 iteration을 실행해야 하며, 이를 위해 iteration-level scheduling과 selective batching을 제안한다.  
   https://www.usenix.org/conference/osdi22/presentation/yu

<a id="ref-pagedattention"></a>

7. **PagedAttention / vLLM**  
   Woosuk Kwon et al., "Efficient Memory Management for Large Language Model Serving with PagedAttention", SOSP 2023. LLM serving에서 KV cache memory가 크고 동적으로 증가/감소하며, fragmentation과 중복이 batch size를 제한한다는 문제를 설명하고 PagedAttention/vLLM을 제안한다.  
   https://arxiv.org/abs/2309.06180

<a id="ref-vllm-apc"></a>

8. **vLLM Automatic Prefix Caching**  
   vLLM 공식 문서, "Automatic Prefix Caching". 같은 prefix를 공유하는 새 query가 기존 query의 KV cache를 재사용해 shared prefix의 computation을 건너뛸 수 있으며, 이 최적화가 주로 prefill phase에 효과가 있음을 설명한다.  
   https://docs.vllm.ai/en/v0.17.1/features/automatic_prefix_caching/

<a id="ref-vllm-prefix-design"></a>

9. **vLLM prefix caching design**  
   vLLM 공식 문서, "Automatic Prefix Caching - Design". KV cache block, hash 기반 prefix caching, block allocation/free/eviction, 그리고 multi-tenant 환경에서 cache reuse를 격리하기 위한 `cache_salt`를 설명한다.  
   https://docs.vllm.ai/en/latest/design/prefix_caching/

<a id="ref-distserve"></a>

10. **DistServe**  
    Yinmin Zhong et al., "DistServe: Disaggregating Prefill and Decoding for Goodput-optimized Large Language Model Serving", OSDI 2024. Prefill과 decode가 서로 간섭하며 TTFT/TPOT SLO를 다르게 압박한다는 문제를 지적하고, 두 단계를 다른 GPU에 배치하는 disaggregated serving 구조를 제안한다.  
    https://arxiv.org/abs/2401.09670

<a id="ref-sarathi"></a>

11. **Sarathi-Serve**  
    Amey Agrawal et al., "Taming Throughput-Latency Tradeoff in LLM Inference with Sarathi-Serve", 2024. 긴 prefill을 chunk로 나누고 decode와 함께 stall-free하게 scheduling하여 throughput-latency tradeoff를 완화하는 접근을 제안한다.  
    https://arxiv.org/abs/2403.02310

<a id="ref-ray-prefix-routing"></a>

12. **Ray Serve LLM request routing**  
    Ray Serve 공식 문서, "Ray Serve LLM Request routing". 기본 routing으로 Power of Two Choices를 설명하고, `PrefixCacheAffinityRouter`가 유사 prefix 요청을 같은 replica로 보내 vLLM Automatic Prefix Caching의 KV cache hit rate를 높이는 방식을 설명한다.  
    https://docs.ray.io/en/latest/serve/llm/architecture/routing-policies.html
