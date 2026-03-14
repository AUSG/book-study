# AoS vs SoA — OOP가 CPU 성능에 주는 영향

> ***Data-Oriented Design (DOD) 가 필요한 이유!***
> 

[1] AoS (Array Of Structure)

```c
struct Player {
    float x, y, z;   // 12 bytes
    float hp;        // 4 bytes
    float speed;     // 4 bytes
    int   pid;        // 4 bytes
};
Player players[10000];
```

vs

[2] SoA (Structure of Array)

```c
struct PlayerSystem {
    float x[10000];
    float y[10000];
    float z[10000];
    float hp[10000];
    float speed[10000];
    int pid[10000];
};
```

**→ 위 코드의 차이가 뭘까?**

- 구조 [1]는 Structure(구조체) 타입의 Array(배열)로, **AoS** 형태
- 구조 [2]는 PlayerSystem이라는 Structure가 존재하고 내부에 배열을 멤버로 가진 구조로, **SoA** 형태

## 메모리 구조적 차이

*위치 정보(x, y, z)를 업데이트 하는 상황을 가정해보자

***fyi. CPU는 데이터를 캐시 라인 단위로 읽으며, 하나의 캐시 라인은 보통 64 btytes로 구성된다***

### AoS

```c
[ x y z hp speed pid ]
[ x y z hp speed pid ]
[ x y z hp speed pid ]

---

캐시에 올라오는 것  →  [ x | y | z | hp | mana | id ]  (24 bytes)
실제 필요한 것      →  [ x | y | z ]                    (12 bytes)
```

- 한 cache line에 들어갈 수 있는 `Player`는 **2개** (64/24bytes) 임
- 10000개의 Player를 순회하면 5000 cache lines 를 읽게 되는 것
- 캐시 활용률: **12 / 64 = 18.75%**

위치 정보(x, y, z)만 업데이트하더라도 hp, speed, pid에 해당하는 구조체 데이터까지 함께 캐시에 올라오게 됨

```c
for (int i=0;i<10000;i++) {
    players[i].x += vx;
    players[i].y += vy;
    players[i].z += vz;
}
```

→ 즉, **객체 중심(Object-centric) 메모리 레이아웃**이라 특정 필드만 순회할 때 **불필요한 데이터 로딩**으로 캐시 낭비가 발생할 수 있다.

### SoA

```c
x x x x x
y y y y y
z z z z z
hp hp hp hp hp
speed speed speed speed speed
pid pid pid pid pid

---

x[] →  [ x x x x x x x x x x x x x x x x ]  ← 캐시 라인 하나 = float 16개
y[] →  [ y y y y y y y y y y y y y y y y ]
z[] →  [ z z z z z z z z z z z z z z z z ]
```

- 한 cache line에 **16개**의 `x` 값(64/4bytes)이 들어갈 수 있음
- 10000개의 Player를 순회하면 625 cache lines 를 읽게 되는 것 (8배 감소)
- 캐시 활용률: **64 / 64 = 100%**

위치 정보(x, y, z)만 업데이트할 때 x[], y[], z[] 필드별로만 연속 접근이 가능하면 되므로 더 효율적이다

```c
for (int i = 0; i < 10000; i++) {
    x[i] += vx;  // Sequential Access → 캐시 라인 100% 활용
    y[i] += vy;
    z[i] += vz;
}
```

→ 즉, **데이터 접근 패턴 중심(Data-access-centric) 메모리 레이아웃**이라 캐시 효율이 높고 SIMD/vectorization에도 유리하다.

✅ *Data-Oriented Design*는 if 분기를 최소화하는 구조를 지향함

- 데이터를 한꺼번에 처리하는 구조가 되므로, 조건부 로직을 루프 밖으로 빼거나, 마스킹연산을 통해 분기 없는 코드를 작성하기 훨씬 유리함

- fyi. https://norvig.com/21-days.html#answers
    
    ```
    CPU cycle      ~1 ns
    L1 cache       ~1 ns
    RAM access     ~100 ns
    ```
    
    → RAM 접근은 CPU보다 **100배 느리다**는 사실을 알 수 있음
    
    → 즉, CPU 성능 문제 대부분이 ‘연산’ 작업보다 ‘메모리 접근’ 때문임을 시사함
    

## CPU 내부에서 실제로 어떤 차이가 생길까?

위와 같은 구조적 차이가 기계 명령어로 컴파일되어 CPU 내부에서 처리될 때는 다음에서 차이가 크게 나타난다

1. **캐시 효율**
    
    위에서 계산했듯 AoS는 5,000 cache lines, SoA는 625 cache lines.
    
    Cache Miss가 발생하면 CPU는 **파이프라인을 멈추고(Stall)** RAM에서 데이터를 기다린다
    
    ```c
    파이프라인 정상:   IF → ID → EX → MEM → WB → IF → ID → EX ...
    Cache Miss 발생:   IF → ID → EX → [STALL ×100 사이클] → MEM → WB
    ```
    
    - AoS : 복잡한 구조체의 듬성듬성한 접근은 프리페처가 예측하기 힘들게 만들어, 결과적으로 CPU가 데이터를 기다리며 노는 **Stall(멈춤)** 현상이 발생함
    - SoA : 루프가 배열의 연속이라 메모리가 선형적으로 정렬되므로, CPU가 **다음 데이터를 미리 예측**하여 캐시에 올려둠 (Prefetching)
    
    **→ 배열의 정렬과 마찬가지로, CPU 캐시 효율을 극적으로 바꿀 수 있는 부분임!**
    
2. **SIMD / 벡터화 (Vectorization)**
    
    현대 CPU는 SIMD(Single Instruction Multiple Data) 명령어로 한 번에 여러 데이터를 처리할 수 있다.
    
    ```c
    일반 연산 (스칼라):  x[0] += vx; x[1] += vx; x[2] += vx; x[3] += vx;  ← 4번
    SIMD 연산:          [x[0] x[1] x[2] x[3]] += [vx vx vx vx]             ← 1번
    ```
    
    SIMD가 동작하려면 **데이터가 메모리에 연속으로 배치**되어 있어야 한다. ⇒ SoA는 컴파일러가 **SIMD 명령(AVX, SSE 등)**을 사용하기 아주 좋은 환경을 만든다
    
    - AoS : `players[i].x`, `players[i].y`가 섞여 있어, CPU가 데이터를 레지스터에 셔플링하게 됨
    - SoA : CPU는 한 번의 명령어로 메모리에서 `x[0]~x[7]`까지를 한 번에 벡터 레지스터로 로드하고, `vx`를 더하는 연산을 **단 한 번의 사이클**에 처리할 수 있음

### SoA의 Trade-off

SoA 찬양 같지만 단점도 명확하다..

1. **엔티티 생성/삭제가 복잡해진다**
    
    AoS에서 플레이어를 삭제하는 건 간단하지만, SoA에서는 **모든 배열을 동시에 동기화**해야 한다.
    
    ```c
    // AoS: 배열에서 하나 제거
    players.erase(players.begin() + i);  // 끝
    
    // SoA: 모든 배열에서 같은 인덱스를 제거해야 함
    x.erase(x.begin() + i);
    y.erase(y.begin() + i);
    z.erase(z.begin() + i);
    hp.erase(hp.begin() + i);
    speed.erase(speed.begin() + i);
    pid.erase(pid.begin() + i);
    // → 필드 추가할 때마다 여기도 추가해야 함 → 실수하면 데이터 불일치
    ```
    
    실무에서는 보통 **swap-and-pop** 패턴으로 해결한다.
    
    ```c
    // 삭제할 인덱스를 마지막 원소와 교체하고 pop
    void remove(int i, int last) {
        x[i] = x[last];
        y[i] = y[last];
        z[i] = z[last];
        // ... 모든 배열 동일하게
        size--;
    }
    // 순서가 바뀌어도 괜찮은 경우에만 사용 가능
    ```
    
    → 순서 보장이 필요하면 쓸 수 없고, 관리 코드가 필연적으로 늘어난다.
    
2. **코드 가독성이 급격히 나빠진다**
    
    ```c
    // AoS: 의도가 명확하다
    if (players[i].hp <= 0) {
        players[i].state = DEAD;
        players[i].deathTime = now;
    }
    
    // SoA: 같은 로직이 이렇게 된다
    if (hp[i] <= 0) {
        state[i] = DEAD;
        deathTime[i] = now;
    }
    // → 필드가 많아질수록 "이게 같은 엔티티 데이터가 맞나?" 추적이 어려움
    // → 버그 발생 시 디버깅이 훨씬 어려움
    ```
    
    `i`라는 인덱스 하나가 여러 배열을 묶는 **암묵적 계약**이 되어버린다. 이 계약이 깨지는 순간 찾기 어려운 버그가 생긴다.
    
3. **멀티스레드 환경에서 락 관리가 복잡해진다**
    
    ```c
    // AoS: 엔티티 하나에 락 하나
    mutex player_lock[N];
    player_lock[i].lock();
    players[i].hp -= damage;
    player_lock[i].unlock();
    
    // SoA: 배열별로 락이 필요하거나, 같은 인덱스를 배열별로 따로 보호해야 함
    // → 교착 상태(Deadlock) 가능성 증가
    // → 락 순서를 항상 일관되게 유지해야 함
    ```
    
    ECS 엔진(Unity DOTS의 Job System 등)이 이 문제를 프레임워크 레벨에서 해결해주는 이유가 바로 여기에 있다.
    

**[SoA가 무의미해지는 경계 조건]**

1. Structure / Array의 수 자체가 많지 않으면 캐시가 이미 처리해버리기 때문에 SoA가 무의미해짐 (코드 가독성만 나빠진 수준..)
    
    ```c
    L3 캐시 용량: 보통 8~32 MB
    Player 구조체: 28 bytes
    28 bytes × 1,000개 = 28 KB  → L2 캐시(보통 256KB~1MB)에 완전히 들어감
    
    ---
    N < ~500     → 차이 미미 (이미 캐시 안에 다 들어감)
    N ~ 1,000    → 차이 체감 시작
    N > 10,000   → SoA 효과 극대화
    ```
    
    → 엔티티 수가 **수백 개 이하**이면 AoS든 SoA든 전체 데이터가 L2/L3 캐시에 다 올라가므로 **실측 차이가 거의 없다**
    
2. **전체 필드 중 필드 사용률에 따라 결정 가능 —** 모든 필드를 다 쓰는 루프라면 SoA가 오히려 불리함
    
    ```c
    // 이런 루프라면?
    for (int i = 0; i < N; i++) {
        players[i].x     += vx;
        players[i].y     += vy;
        players[i].z     += vz;
        players[i].hp    -= damage[i];
        players[i].speed *= friction;
        // → 모든 필드를 다 사용
    }
    ```
    
    이 경우 AoS는 `players[i]` 하나를 캐시에 올리면 끝임
    
    SoA는 `x[]`, `y[]`, `z[]`, `hp[]`, `speed[]` 배열을 **각각 따로 접근**해야 하므로 오히려 캐시 라인을 더 많이 사용할 수 있다.
    

## 관련 사례 및 파생 개념

### **1.** Insomniac Games의 Data-Oriented Design 도입

Insomniac Games(스파이더맨 시리즈 개발사)의 엔진 프로그래머 **Mike Acton**이 CppCon 2014에서 발표한 내용이 업계에 큰 반향을 일으켰다.

> *"RAM 읽기 비용이 SQRT 연산보다 비싸다"*
> 

당시 3D 엔진들은 OOP 구조(AoS)로 설계되어 있었고, Ogre3D 같은 엔진이 CPU 시간의 대부분을 연산이 아닌 **메모리 대기**에 소비하고 있다는 걸 프로파일링으로 보여줬다.

핵심 주장:

- 대부분의 성능 문제는 **"어떻게 계산하는가"가 아니라 "어디서 데이터를 읽는가"** 에서 온다
- OOP의 추상화는 개발자 편의를 위한 것이고, CPU는 추상화를 모른다
- 데이터를 어떻게 접근하는지에 맞게 **데이터를 먼저 설계**해야 한다 → **Data-Oriented Design(DOD)**

### 2. **Unity DOTS** — OOP 구조 → ECS(Entity Component System) 전환

Unity는 전통적으로 `MonoBehaviour` 기반의 OOP 구조(사실상 AoS)를 사용했다.

```c
전통 Unity (OOP/AoS):
GameObject → [Transform][Renderer][Collider][Script ...]
             ← 객체 안에 모든 컴포넌트가 묶여 있음
```

그런데 씬에 오브젝트가 수천 개가 되면 Update 루프에서 **Cache Miss 폭발**이 발생한다.

```c
ECS (DOTS/SoA):
Position[]  → [p p p p p p p p ...]   ← 위치만 연속
Velocity[]  → [v v v v v v v v ...]   ← 속도만 연속
Health[]    → [h h h h h h h h ...]   ← 체력만 연속
```

**[ECS 전환의 이점]**

1. 로직 분리 (System 관졈) - 시스템은 오로지 “특정 컴포넌트 조합”만을 처리하면 된다
2. 데이터 응집 (Component 관점) - 컴포넌트는 SoA 형태로 메모리에 빽빽하게 배치된다

→ ECS가 고성능 게임 엔진의 표준으로 불리는 이유

**비교*

|  | 전통 OOP (MonoBehaviour) | ECS (DOTS) |
| --- | --- | --- |
| 메모리 구조 | AoS — 객체 안에 모든 데이터 | SoA — 컴포넌트별로 분리 |
| 캐시 효율 | 낮음 (불필요한 필드 로딩) | 높음 (필요한 컴포넌트만 접근) |
| SIMD 적용 | 어려움 | 자동 벡터화 가능 |
| 멀티스레드 | 공유 상태 문제 많음 | Job System으로 안전한 병렬화 |

결과: 동일한 씬에서 오브젝트 **수만 개를 60fps로** 처리 가능. OOP 구조 대비 수십 배 성능 향상 사례 보고

### 3. **Column Database**

![image.png](attachment:a69fbb47-a6eb-41b9-b13b-9e3576c9dafe:image.png)

위 캐시 메모리 배치 형태를 보면 Columnar Database를 떠올릴 수 있는데, SoA와 동일한 원리로 볼 수 있다

- **Columnar DB가 빠른 상황**
    
    분석 쿼리처럼 **특정 컬럼만** 읽는 경우
    
    ```sql
    SELECT AVG(age) FROM users;
    ```
    
    - Row DB: 모든 row(name, age, salary)를 캐시에 올려야 age를 읽을 수 있음
    - Column DB: age[] 배열만 Sequential Read → **캐시 효율 극대화**
    
    **대표 예시:** Apache Parquet, ClickHouse, BigQuery, Amazon Redshift
    
- **Columnar DB가 느린 상황**
    
    ```sql
    SELECT * FROM users WHERE id = 123;
    ```
    
    단건 조회처럼 **한 row 전체**를 읽는 경우 — 각 컬럼이 흩어져 있어 오히려 비효율
    

→ OLTP(트랜잭션)에는 Row DB, OLAP(분석)에는 Column DB가 적합한 이유임

## 그럼 OOP 와 DOD가 어떻게 평화롭게 공존할 수 있을지?

AoS와 SoA 중 SoA가 무조건 좋다는 것은 아님. 데이터 접근 패턴과 종류에 따라 적합한 결정이 필요하고, 데이터를 처음부터 잘 설계하는 것이 결국 중요한 것

- 전체 엔티티의 일부 필드를 순회하는 패턴 → SoA가 유리함
- 하나의 엔티티의 모든 필드를 사용하는 패턴 → AoS가 유리함

### 데이터 어떻게 설계하나요.?

### $Latency_{RAM} >> Latency_{Cache} \approx Latency_{CPU}$

데이터를 CPU가 linear하게 소비할 수 있도록 하는 것이 성능 최적화의 핵심 !

### 자주 사용되는 패턴

1. 외부 -  OOP / 내부 - SoA
    
    ```c
    // 외부 인터페이스는 OOP 그대로
    class Player {
    public:
        float getX() const { return system.x[index]; }
        void  setX(float v) { system.x[index] = v; }
    private:
        PlayerSystem& system;  // 내부는 SoA 참조
        int index;
    };
    ```
    
    → Getter, Setter가 왜 필요한지를 보여줌.. OOP API를 통해 데이터에 접근하면서 실제 메모리 관점에서는 SoA로 관리되게 할 수 있다
    
2. Hot / Cold를 분리
    
    자주 접근하는 데이터(hot)와 가끔 접근하는 데이터(cold)를 구조체에서 분리하는 방식이다
    
    | **구분** | **영역** | **전략** |
    | --- | --- | --- |
    | **Hot Path** | 렌더링, 물리 연산, AI 업데이트 | **DOD (SoA 기반)** |
    | **Cold Path** | 인벤토리 관리, 퀘스트 수락, UI 로직 | **OOP (AoS/객체지향)** |
    
    ```c
    // ❌ 한 구조체에 다 넣기
    struct Player {
        float x, y, z;       // 매 프레임 접근 (hot)
        float hp, mana;      // 전투 시에만 접근 (warm)
        char  name[32];      // 거의 안 씀 (cold)
        int   achievement[50]; // 매우 가끔 (cold)
    };
    
    // ✅ Hot/Cold 분리
    struct PlayerTransform { float x, y, z; };          // 매 프레임
    struct PlayerCombat    { float hp, mana; };          // 전투 시
    struct PlayerProfile   { char name[32]; int ach[50]; }; // 가끔
    ```
    
    → 매 프레임 도는 루프에서 `PlayerTransform[]`만 캐시에 올라옴
    

> — 결론 —
> 
> 
> OOP를 버리는 게 아니라 **성능이 중요한 곳에서만 메모리 배치를 의식**하면 된다.
> 먼저 OOP로 설계하고, 프로파일러가 가리키는 곳을 SoA로 바꾸기 !
>
