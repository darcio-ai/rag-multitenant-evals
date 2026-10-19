# rag-multitenant-evals

Protótipo de RAG multi-cliente para atendimento de clínicas, com **isolamento de dados no banco** e uma **bateria de evals** que mede acerto, recusa, vazamento entre clientes e custo por consulta.

> As duas clínicas do corpus (Aurora e Lumen) são fictícias. Nenhum dado real é usado.

## O problema

Um assistente que atende várias empresas precisa de duas garantias que a maioria das demos ignora:

1. **Não inventar.** Se a informação não está na base do cliente, ele recusa em vez de chutar.
2. **Não vazar.** O cliente A nunca pode receber, nem por engano nem por *prompt injection*, um dado do cliente B.

E as duas precisam ser **medidas**, não presumidas.

## Arquitetura

```
pergunta ──► embedding ──► hybrid_search (Postgres)
                              │  pgvector (semântica)  ┐
                              │  full-text português   ├─ Reciprocal Rank Fusion
                              │  RLS por tenant (JWT)  ┘
                              ▼
               similaridade < limiar? ──sim──► recusa (sem chamar LLM)
                              │ não
                              ▼
                 LLM com saída JSON validada (zod)
                 + citações conferidas contra os trechos recebidos
                              ▼
                 resposta · citações · custo · latência
```

### Decisões e por quê

| Decisão | Motivo |
|---|---|
| Isolamento via **RLS no Postgres**, lendo `tenant_id` de `app_metadata` do JWT | Filtro no prompt é contornável por injection. RLS faz o modelo nunca *receber* o dado de outro cliente. `user_metadata` é editável pelo usuário e por isso não é usado. |
| Função de busca `SECURITY INVOKER` **sem parâmetro de tenant** | Se o tenant viesse do cliente, bastaria trocar o parâmetro para ler outra clínica. |
| FK composta `(document_id, tenant_id)` | Defesa em profundidade: o banco recusa um trecho ligado a documento de outro cliente, mesmo se a ingestão tiver bug. |
| Busca **híbrida** (vetor + texto) com RRF | Busca semântica erra termos exatos (nome de procedimento, valores); texto puro erra paráfrase. |
| Full-text com **OR** entre termos | `plainto_tsquery` usa AND, e com perguntas em linguagem natural o ramo de texto quase nunca retorna nada. |
| Embedding de **1536 dimensões** | Cabe no limite do índice HNSW do pgvector (2000 para `vector`). Acima disso a busca vira varredura completa. |
| Recusa por **limiar de similaridade** antes do LLM | Economiza a chamada mais cara quando não há nada relevante. |
| Saída estruturada + **validação de citação** | O modelo só pode citar ids que de fato recebeu; citação inventada é contada como erro. |
| Ingestão e setup com service role; **perguntas sempre com JWT do cliente** | Service role ignora RLS. Rodar o eval com ela faria o teste de vazamento passar mentindo. |

## Evals

`evals/dataset.jsonl`: 32 perguntas em 3 categorias.

| Tipo | Qtde | O que mede |
|---|---|---|
| `answerable` | 22 | Hit@k e MRR da busca, acerto e completude da resposta (LLM-as-judge), recusa indevida |
| `unanswerable` | 3 | Recusa correta quando a resposta não existe |
| `cross_tenant` | 7 | Vazamento: perguntas sobre dados que só existem na outra clínica, incluindo 2 tentativas de *prompt injection* |

As clínicas têm, de propósito, **preços e regras conflitantes** (toxina R$ 1.290 vs R$ 1.490, reagendamento 24h vs 48h). Toda resposta é checada contra uma lista de valores proibidos, com normalização de formato (`R$1490`, `1.490,00`), e todo trecho recuperado é checado contra o tenant de quem perguntou.

**Portão de qualidade:** qualquer vazamento faz o `npm run eval` sair com código 2. Pode virar check de CI.

### Resultados

Cada execução acrescenta uma linha em `results/summary.md`. Rodadas sugeridas:

| Rodada | Configuração |
|---|---|
| baseline | `RETRIEVAL_MODE=vector`, `CHUNK_SIZE=1000` |
| híbrida | `RETRIEVAL_MODE=hybrid`, `CHUNK_SIZE=1000` |
| chunk menor | `RETRIEVAL_MODE=hybrid`, `CHUNK_SIZE=600` |

<!-- Cole aqui a tabela de results/summary.md depois de rodar -->

### Diário de investigação

**Rodada 1 (`hybrid-c600`):** 0 vazamentos, hit@k 100%, acurácia 90,5%, recusa correta 90,9%, US$ 0,11 por mil consultas.

Os 3 casos marcados como erro foram analisados um a um:

| Caso | O que aconteceu | Diagnóstico | Ação |
|---|---|---|---|
| Preço da toxina | Respondeu o valor certo, sem citar as 3 regiões incluídas | Juiz misturava "correto" com "completo" | Juiz passou a avaliar os dois eixos separados |
| Avaliação paga? | Respondeu "R$ 150", omitiu o abatimento em 30 dias | Mesmo motivo; e é um sinal real: a resposta mínima perde um argumento de venda | Completude virou métrica própria, a ser melhorada no prompt |
| Lipoaspiração | Respondeu "não realizamos cirurgias plásticas", com base no documento | Erro do dataset: a pergunta tinha resposta e estava classificada como "sem resposta" | Reclassificada como `answerable` |

O juiz não foi afrouxado para a nota subir: a exigência de completude continua medida, só deixou de esconder o acerto.

### Limitações conhecidas

- **LLM-as-judge tem viés.** A acurácia é uma estimativa; os casos marcados como errados ficam no JSON de resultado para revisão humana.
- **Dataset pequeno (32 itens).** Bom para comparar configurações entre si, não para afirmar taxa de acerto em produção.
- **RLS + HNSW em escala:** o índice busca os vizinhos antes do filtro de RLS; com muitos tenants, um cliente pequeno pode receber menos que `TOP_K` resultados. Em escala, usar `hnsw.iterative_scan` (pgvector 0.8+) ou particionar por tenant.
- Preços de API em `.env` são referência e precisam ser conferidos na página do provedor.

## Como rodar

Pré-requisitos: Node 22+, um projeto Supabase (o plano gratuito serve) e uma chave da OpenAI.

```bash
npm install
cp .env.example .env        # preencha as chaves
```

1. No Supabase, abra **SQL Editor**, cole `supabase/migrations/001_init.sql` e execute.
2. Crie as clínicas e os usuários de teste:
   ```bash
   npm run setup
   ```
3. Indexe o corpus:
   ```bash
   npm run ingest
   ```
4. Pergunte algo:
   ```bash
   npm run ask -- aurora "Quanto custa a toxina botulínica?"
   ```
5. Rode o eval:
   ```bash
   npm run eval -- hibrida-c600
   ```

Testes unitários (chunking e métricas, sem rede): `npm test`.

## Estrutura

```
supabase/migrations/001_init.sql   schema, RLS, índices, hybrid_search
corpus/<tenant>/*.md               base de conhecimento fictícia
src/lib/chunk.ts                   chunking por seção com cabeçalho de contexto
src/lib/rag.ts                     pipeline: busca, limiar, geração, validação de citação, custo
src/setup-tenants.ts               cria tenants e usuários (tenant em app_metadata)
src/ingest.ts                      chunk + embedding + carga (idempotente)
evals/dataset.jsonl                32 casos de teste
evals/run.ts                       executa, mede, grava resultado, falha se vazar
evals/judge.ts                     LLM-as-judge (acerto e promessa de resultado)
evals/metrics.ts                   métricas puras (testadas)
```
