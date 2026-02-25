# Pacote de Integração WebRTC 1:1 (Substituto Agora)

Projeto base para videochamada 1:1 usando WebRTC nativo, com signaling em Socket.io e fallback TURN (Coturn) para redes 4G/restritas.

## Stack
- Backend: Node.js + Express + Socket.io
- Frontend: EJS + Bootstrap + JavaScript nativo
- Mídia: WebRTC P2P (trickle ICE)
- Infra de conectividade: STUN + TURN (Coturn com `use-auth-secret`)

## Estrutura do pacote
- `server.js`: Express, Socket.io, salas 1:1, ICE config, credenciais TURN efêmeras
- `views/index.ejs`: tela da chamada (`Você` / `Participante`) e controles
- `public/js/webrtc.js`: fluxo WebRTC + botões de mídia + encerramento de sessão
- `public/css/call.css`: layout e responsividade da interface
- `.env.example`: variáveis de ambiente

## Requisitos
- Node.js 18+ (recomendado 20+)
- NPM 9+
- Linux para Coturn em produção

## Execução local
1. Instale dependências:
```bash
npm install
```
2. Crie o `.env`:
```bash
cp .env.example .env
```
No Windows PowerShell:
```powershell
Copy-Item .env.example .env
```
3. Inicie:
```bash
npm run dev
```
4. Gere uma sala UUID v4:
```bash
node -e "console.log(require('node:crypto').randomUUID())"
```
5. Acesse:
`http://localhost:3000/call/<uuid-v4>`

## Testes automatizados (comprovação de funcionamento)
1. Instale dependências:
```bash
npm install
```
2. Rode a suíte de integração:
```bash
npm test
```
3. Rode o teste de carga padrão (300 salas 1:1):
```bash
npm run test:load
```

### O que os testes cobrem
- `tests/http.integration.test.js`
  - `GET /healthz` retorna `status=ok`
  - validação de `roomId` em `/call/:roomId`
  - retorno de `ice-config` com STUN + TURN efêmero
- `tests/socket.integration.test.js`
  - limite 1:1 com bloqueio do 3º usuário (`room:full`)
  - isolamento de salas (sem cross-talk) em `webrtc:offer`
  - propagação de `media:state` para o par correto
  - evento `room:peer-left` ao desconectar
  - proteção de signaling com `NOT_IN_ROOM`
- `tests/load/signaling-load.js`
  - simulação de 300 salas com 2 participantes/sala
  - validação de conexão e isolamento de signaling por sala

### Parâmetros opcionais do load test
```bash
LOAD_ROOMS=300 LOAD_BATCH_SIZE=30 LOAD_EVENT_TIMEOUT_MS=5000 npm run test:load
```
No PowerShell:
```powershell
$env:LOAD_ROOMS=300; $env:LOAD_BATCH_SIZE=30; $env:LOAD_EVENT_TIMEOUT_MS=5000; npm run test:load
```

## Contratos públicos

### HTTP
- `GET /healthz` -> `{ status, uptime, timestamp }`
- `GET /call/:roomId` -> valida UUID v4 e renderiza a página da chamada
- `GET /api/webrtc/ice-config?roomId=<uuid-v4>` -> retorna:
```json
{
  "iceTransportPolicy": "all",
  "iceServers": [
    { "urls": ["stun:stun.l.google.com:19302"] },
    {
      "urls": ["turn:turn.seudominio.com:3478?transport=udp", "turn:turn.seudominio.com:3478?transport=tcp"],
      "username": "<timestamp:roomId>",
      "credential": "<hmac-base64>"
    }
  ]
}
```

### Socket.io events
#### Client -> Server
- `room:join` `{ roomId }`
- `room:leave` `{ roomId }`
- `webrtc:offer` `{ roomId, sdp }`
- `webrtc:answer` `{ roomId, sdp }`
- `webrtc:ice-candidate` `{ roomId, candidate }`
- `media:state` `{ roomId, audioEnabled, videoEnabled }`

#### Server -> Client
- `room:joined` `{ roomId, socketId, participantCount }`
- `room:full` `{ roomId, maxParticipants: 2 }`
- `room:peer-joined` `{ peerId }`
- `room:peer-left` `{ peerId }`
- `webrtc:offer` `{ sdp }`
- `webrtc:answer` `{ sdp }`
- `webrtc:ice-candidate` `{ candidate }`
- `media:state` `{ peerId, audioEnabled, videoEnabled }`
- `error` `{ code, message }`

## Regras funcionais implementadas
- Salas isoladas por `roomId` UUID v4
- Limite estrito de 2 participantes por sala
- 3º participante recebe `room:full`
- Encerramento de sessão limpa `RTCPeerConnection`, tracks locais e socket
- Política ICE padrão: `all` com fallback TURN
- Modo escala: `REDIS_URL` habilita adapter Redis para scale-out horizontal

## Variáveis de ambiente
Use `.env.example` como base:

| Variável | Obrigatória | Descrição |
|---|---|---|
| `PORT` | Não | Porta HTTP do app |
| `TRUST_PROXY` | Não | `true` se estiver atrás de proxy |
| `STUN_URLS` | Não | Lista STUN separada por vírgula |
| `TURN_URLS` | Sim (produção) | Lista TURN separada por vírgula |
| `TURN_SHARED_SECRET` | Sim (produção) | Segredo Coturn (`static-auth-secret`) |
| `TURN_CREDENTIAL_TTL_SECONDS` | Não | TTL das credenciais efêmeras |
| `ICE_TRANSPORT_POLICY` | Não | `all` (default) ou `relay` |
| `REDIS_URL` | Não | Ativa Redis adapter no Socket.io |

## Configuração de Coturn (Linux Ubuntu/Debian)

### 1) Instalar
```bash
sudo apt update
sudo apt install -y coturn
```

### 2) Habilitar serviço
```bash
sudo sed -i 's/^#TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn
```

### 3) Configurar `/etc/turnserver.conf`
Exemplo mínimo:
```conf
fingerprint
use-auth-secret
static-auth-secret=SEU_SEGREDO_FORTE
realm=seu-dominio.com

listening-port=3478
tls-listening-port=5349

min-port=49152
max-port=65535

external-ip=IP_PUBLICO
no-cli
no-loopback-peers
no-multicast-peers
```

### 4) Reiniciar e validar
```bash
sudo systemctl enable coturn
sudo systemctl restart coturn
sudo systemctl status coturn --no-pager
sudo journalctl -u coturn -n 100 --no-pager
```

### 5) Firewall (exemplo UFW)
```bash
sudo ufw allow 3478/tcp
sudo ufw allow 3478/udp
sudo ufw allow 5349/tcp
sudo ufw allow 49152:65535/udp
```

## Passo a passo de integração no projeto do cliente (arrastar arquivos)

### Opção A (mais rápida): incorporar o pacote completo
1. Copiar para o projeto do cliente:
   - `server.js` (ou adaptar conteúdo para o servidor existente)
   - `views/index.ejs`
   - `public/js/webrtc.js`
   - `public/css/call.css`
2. Garantir no Express existente:
```js
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
```
3. Injetar rotas:
   - `GET /healthz`
   - `GET /call/:roomId`
   - `GET /api/webrtc/ice-config`
4. Injetar handlers Socket.io:
   - `room:join`, `room:leave`, `webrtc:*`, `media:state`
5. Configurar `.env` com TURN e (opcional) Redis.

### Opção B: integração por módulos
Mover a lógica de sala/sinalização para seu módulo de tempo real e manter os mesmos contratos de evento listados neste README.

## Checklist de validação de entrega
1. Abrir duas abas/dispositivos no mesmo `roomId` UUID v4.
2. Confirmar áudio/vídeo nos dois lados.
3. Tentar terceiro cliente no mesmo `roomId` e validar `room:full`.
4. Alternar `Mic` e `Câmera` e validar propagação `media:state`.
5. Clicar `SAIR` e confirmar evento `room:peer-left` no outro cliente.
6. Testar em rede restrita/4G e verificar estabelecimento com TURN relay.

## Escalabilidade (300+ salas)
- Cada sala é isolada por ID e aceita apenas 2 sockets.
- Para múltiplas instâncias Node, configure `REDIS_URL` e execute Redis.
- Balanceador deve manter WebSocket habilitado e afinidade recomendada.

## Observações operacionais
- Segurança de acesso à sala depende de `roomId` forte: use UUID v4 não sequencial.
- Este pacote não inclui autenticação de usuário, gravação, chat, screen share ou SFU.
- Para produção, use HTTPS/WSS no app principal ou reverse proxy.
