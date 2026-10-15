# 🔔 Alerta de Saques

Manda notificação no celular quando passa muito tempo (padrão 3h) sem ninguém pedir saque, sinal de que o saque pode ter quebrado.

- **Site (PWA)**: pasta `docs/`, hospedada no GitHub Pages. Serve só para ativar as notificações no celular.
- **Monitor**: `check.mjs`, roda no GitHub Actions a cada ~5 min, consulta o backoffice e envia o push.

## Alertas

| Alerta | Quando |
|---|---|
| 💸 Saque: valor moeda | Entrou um pedido de saque novo (mostra valor, moeda, jogador e hora). Se entrarem mais de 5 de uma vez, vem um resumo só. Desligue com a variável `NOTIFY_EACH_WITHDRAWAL` = `false` |
| ⚠️ Nenhum saque há Xh | Passaram `NO_WITHDRAW_HOURS` horas (padrão **3**) sem nenhum pedido de saque de jogador real, em qualquer status. Mostra valor e moeda do último saque |
| ✅ Saques voltaram | Entrou um pedido novo depois de um alerta |
| ❌ Monitor com erro | Login ou API do backoffice falharam |
| ✅ Monitor voltou | O acesso ao backoffice voltou depois de um erro |

**Madrugada:** entre `NIGHT_START` e `NIGHT_END` (padrão **0h às 7h**, horário de `TIMEZONE`, padrão `America/Bogota`), o limite sobe para `NIGHT_HOURS` (padrão **6h**). O limite maior também vale quando o último saque foi feito de madrugada, pra não disparar alerta às 7h só porque a noite foi parada.

Enquanto continuar sem saque, o alerta repete a cada `REPEAT_MINUTES` (padrão `60`). Usuários de teste são ignorados.

## Passo a passo

### 1. Criar o repositório
Crie um repositório **privado** no GitHub e suba estes arquivos.

### 2. Gerar as chaves de push (VAPID)
No computador, com Node instalado:
```
npx web-push generate-vapid-keys
```
- Cole a **Public Key** no arquivo `docs/config.js` e faça commit.
- Guarde a **Private Key** para o passo 4. Ela nunca vai no código.

### 3. Ligar o GitHub Pages
Settings → Pages → Source: **Deploy from a branch** → Branch `main`, pasta **/docs** → Save.
Em ~1 minuto o site fica em `https://SEU-USUARIO.github.io/NOME-DO-REPO/`.

> Repositório privado com Pages exige plano pago (Pro/Team). No plano grátis, deixe o repositório **público**: o site e o código não têm nenhuma senha, tudo sensível fica nos Secrets.

### 4. Cadastrar os Secrets
Settings → Secrets and variables → Actions → **New repository secret**:

| Secret | Valor |
|---|---|
| `BO_EMAIL` | e-mail de um admin do backoffice (de preferência um usuário só para isso) |
| `BO_PASSWORD` | senha desse admin |
| `VAPID_PUBLIC_KEY` | a Public Key do passo 2 |
| `VAPID_PRIVATE_KEY` | a Private Key do passo 2 |
| `PUSH_SUBSCRIPTIONS` | preenchido no passo 5 |

Na aba **Variables** (opcional): `NO_WITHDRAW_HOURS`, `NIGHT_HOURS`, `NIGHT_START`, `NIGHT_END`, `TIMEZONE`, `REPEAT_MINUTES`, `NOTIFY_EACH_WITHDRAWAL`, `VAPID_SUBJECT` (ex.: `mailto:voce@email.com`) e `BO_LOGIN_PATH` (se o login do backoffice não for `/api/auth/admin/login`).

### 5. Ativar no celular
1. Abra o site do passo 3 no celular.
   - **iPhone**: abra no **Safari** → Compartilhar → **Adicionar à Tela de Início** → abra pelo ícone. Precisa de iOS 16.4 ou mais novo.
   - **Android**: abra no Chrome. Pode instalar também (menu ⋮ → Instalar app).
2. Toque em **Ativar notificações** e permita.
3. Toque em **Copiar código** e cole no secret `PUSH_SUBSCRIPTIONS`, dentro de colchetes:
   ```
   [ {código do celular 1} ]
   ```
   Para mais de um aparelho, separe com vírgula: `[ {celular 1}, {celular 2} ]`

### 6. Testar
Actions → **Checar saques** → **Run workflow**. O log mostra quando foi o último pedido de saque. Para testar a notificação, crie a variável `NO_WITHDRAW_HOURS` = `0.01`, rode, e depois apague a variável.

## Problemas comuns
- **"Login falhou (HTTP 4xx)"**: o caminho ou o formato do login do backoffice é diferente. Abra o backoffice, F12 → Network, faça login e veja a URL da requisição de login. Coloque o caminho na variável `BO_LOGIN_PATH`. Se o login pedir código 2FA, este método não funciona; nesse caso use `BO_COOKIE` ou peça uma chave de API ao time do backoffice.
- **Notificação não chega no iPhone**: confirme que abriu pelo ícone da Tela de Início, e não pelo Safari.
- **Log "inscrição expirada (410)"**: ative de novo no celular e troque o código no `PUSH_SUBSCRIPTIONS`.
- O GitHub desativa o agendamento depois de 60 dias sem commits no repositório. Se isso acontecer, é só reativar na aba Actions.
