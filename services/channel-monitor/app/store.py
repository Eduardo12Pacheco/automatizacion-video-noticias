from __future__ import annotations

from .store_base import MonitorStoreBase
from .store_schema import SchemaStoreMixin
from .store_dismissals import DismissalStoreMixin
from .store_channels import ChannelStoreMixin
from .store_videos import VideoStoreMixin
from .store_classification import ClassificationStoreMixin
from .store_cards import CardStoreMixin
from .store_preflight import PreflightStoreMixin
from .store_records import *
from .store_row_mappers import *


class MonitorStore(
    PreflightStoreMixin,
    CardStoreMixin,
    ClassificationStoreMixin,
    VideoStoreMixin,
    ChannelStoreMixin,
    DismissalStoreMixin,
    SchemaStoreMixin,
    MonitorStoreBase,
):
    """SQLite-backed monitor store composed from its concern mixins."""
