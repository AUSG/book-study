# 클라이언트 식별과 쿠키

### HTTP 헤더로 식별

From 헤더는 이메일 주소
- 식별력이 높아보이지만, 악의적인 서버가 이메일을 모아서 사용할 수 있음
  User-Agent는 사용자가 사용하고 있는 브라우저의 이름과 버전 정보, 운영체제에 대한 정보
- 특정 사용자 식별에는 큰 도움X
  Referer 헤더: 현재 페이지로 유입하게 한 웹페이지의 URL
- 사용자 식별은 어렵지만, 행동 분석엔 용이

### 클라이언트 IP 주소로 식별

식별력이 높아보이지만, 아래 케이스처럼 아닌 경우가 많음
- 여러 사용자가 하나의 컴퓨터를 사용하는 경우
- ISP에서 동적으로 IP 주소를 할당하는 경우
- NAT 장비들이 클라이언트의 실제 IP 주소를 방화벽 뒤에 숨기는 경우
- HTTP 프록시와 게이트웨이를 타는 경우

### 사용자 로그인

로그인을 통해 사용자를 식별하는 게 좋긴하다.

### 뚱뚱한 URL

사용자의 정보(ex: 식별번호)를 URL에 기술하여 사용자를 식별하고 추적하도록 하는 것
허나 아래와 같은 단점이 있음
- 못생긴 URL: 사용자들에게 혼란을 줌
- 공유하지 못하는 URL: 식별번호가 박혀있다보니 외부에 공유하면 개인정보를 공유하는 것
- 캐시를 사용할 수 없음: URL이 달라지기 때문에 캐시 사용이 어려움
- 서버 부하 가중: 서버는 뚱뚱한 URL에 해당하는 HTML 페이지를 다시 그려야 함
- 이탈: 해당 URL 세션에서 의도치 않게 쉽게 이탈이 가능함
- 세션 간 지속성의 부재: 로그아웃하면 모든 정보를 잃음

### 쿠키
사용자를 식별하고 세션을 유지하는 방식 중에서 가장 널리 사용되는 방식

##### 동작 방식
Set-Cookie 헤더가 응답 헤더에 기술되어 사용자에게 전달되면, 사용자는 이후 요청에 쿠키 헤더를 설정하여 요청에 보냄

##### 쿠키와 캐싱
1. 캐시되지 말아야 할 문서가 있다면 표시하라
2. Set-Cookie 헤더를 캐시 하는 것에 유의하라
3. Cookie 헤더를 가지고 있는 요청을 주의하라

