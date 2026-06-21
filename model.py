"""
model.py — Time2Vec + Conv1D 투영 + TransformerEncoder + GAP 헤드

아키텍처 흐름:
  입력 [B, 20, 11]
  → Time2Vec 임베딩 concat [B, 20, 11+t2v_dim]
  → Conv1D 투영 → [B, 20, d_model]
  → TransformerEncoder [B, 20, d_model]
  → Global Average Pooling → [B, d_model]
  → Linear → [B, 1] → squeeze → [B]
"""

import math
import torch
import torch.nn as nn


# ──────────────────────────────────────────────
# Time2Vec
# ──────────────────────────────────────────────

class Time2Vec(nn.Module):
    """
    t2v(τ)[0]   = ω₀·τ + φ₀          (선형)
    t2v(τ)[i≥1] = sin(ωᵢ·τ + φᵢ)    (주기적)

    출력 shape: (B, T, k)  where k = time2vec_dim
    """

    def __init__(self, time2vec_dim: int = 4):
        super().__init__()
        self.k = time2vec_dim
        self.W = nn.Parameter(torch.randn(time2vec_dim))
        self.b = nn.Parameter(torch.randn(time2vec_dim))

    def forward(self, t: torch.Tensor) -> torch.Tensor:
        # t: (B, T) — 타임스텝 인덱스(0~19), float
        t = t.unsqueeze(-1)              # (B, T, 1)
        v = t * self.W + self.b          # (B, T, k)
        # 첫 차원: 선형, 나머지: sin
        out = torch.cat([v[..., :1], torch.sin(v[..., 1:])], dim=-1)
        return out                        # (B, T, k)


# ──────────────────────────────────────────────
# 메인 모델
# ──────────────────────────────────────────────

class StockTransformer(nn.Module):
    """
    인코더 전용 트랜스포머 for 주가 예측.

    Args:
        n_features:     입력 feature 수 (11)
        d_model:        Transformer 모델 차원 (64)
        nhead:          어텐션 헤드 수 (4)
        num_layers:     인코더 레이어 수 (2)
        dim_feedforward: FFN 내부 차원 (128)
        dropout:        드롭아웃 (0.3)
        time2vec_dim:   Time2Vec 출력 차원 (4)
        conv_kernel:    Conv1D 커널 크기 (3)
        activation:     'gelu' or 'relu'
    """

    def __init__(
        self,
        n_features: int = 11,
        d_model: int = 64,
        nhead: int = 4,
        num_layers: int = 2,
        dim_feedforward: int = 128,
        dropout: float = 0.3,
        time2vec_dim: int = 4,
        conv_kernel: int = 3,
        activation: str = "gelu",
    ):
        super().__init__()
        self.n_features   = n_features
        self.d_model      = d_model
        self.time2vec_dim = time2vec_dim

        # ── Time2Vec ────────────────────────────────────────────────────────
        self.time2vec = Time2Vec(time2vec_dim)

        # ── Conv1D 투영: (n_features + time2vec_dim) → d_model ──────────────
        in_ch = n_features + time2vec_dim
        padding = (conv_kernel - 1) // 2   # 길이 유지
        self.conv_proj = nn.Sequential(
            nn.Conv1d(in_ch, d_model, kernel_size=conv_kernel, padding=padding),
            nn.GELU() if activation == "gelu" else nn.ReLU(),
            nn.Dropout(dropout),
        )

        # ── TransformerEncoder ───────────────────────────────────────────────
        enc_layer = nn.TransformerEncoderLayer(
            d_model=d_model,
            nhead=nhead,
            dim_feedforward=dim_feedforward,
            dropout=dropout,
            activation=activation,
            batch_first=True,
            norm_first=True,   # Pre-LN: 학습 안정성 개선
        )
        self.encoder = nn.TransformerEncoder(enc_layer, num_layers=num_layers)

        # ── 출력 헤드: GAP → Linear ─────────────────────────────────────────
        self.head = nn.Linear(d_model, 1)

        self._init_weights()

    def _init_weights(self):
        for p in self.parameters():
            if p.dim() > 1:
                nn.init.xavier_uniform_(p)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        """
        x: (B, T, F) — T=20, F=11
        returns: (B,) — 예측 스칼라
        """
        B, T, F = x.shape

        # Time2Vec: 타임스텝 0~T-1
        t = torch.arange(T, dtype=torch.float32, device=x.device)
        t = t.unsqueeze(0).expand(B, -1)    # (B, T)
        t2v = self.time2vec(t)              # (B, T, time2vec_dim)

        # concat feature + time2vec
        h = torch.cat([x, t2v], dim=-1)    # (B, T, F+time2vec_dim)

        # Conv1D는 (B, C, L) 포맷
        h = h.permute(0, 2, 1)             # (B, C, T)
        h = self.conv_proj(h)              # (B, d_model, T)
        h = h.permute(0, 2, 1)             # (B, T, d_model)

        # TransformerEncoder
        h = self.encoder(h)                # (B, T, d_model)

        # Global Average Pooling (시간축)
        h = h.mean(dim=1)                  # (B, d_model)

        # 출력
        out = self.head(h).squeeze(-1)     # (B,)
        return out


# ──────────────────────────────────────────────
# 모델 파라미터 수 출력 유틸
# ──────────────────────────────────────────────

def count_parameters(model: nn.Module) -> int:
    return sum(p.numel() for p in model.parameters() if p.requires_grad)


if __name__ == "__main__":
    model = StockTransformer()
    print(f"파라미터 수: {count_parameters(model):,}")
    x = torch.randn(4, 20, 11)
    out = model(x)
    print(f"출력 shape: {out.shape}")   # (4,)
