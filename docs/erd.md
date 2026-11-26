# 냉장고 ERD

```mermaid
erDiagram
    refrigerators ||..|{ refrigerator_rows : "단 구성"
    refrigerator_rows ||..|{ refrigerator_compartments : "본체 구성"
    refrigerator_rows ||..|{ refrigerator_doors : "문 배치"
    refrigerator_compartments ||..|{ refrigerator_doors : "개폐부 연결"
    refrigerator_compartments |o..|{ refrigerator_slots : "본체 칸"
    refrigerator_doors |o..|{ refrigerator_slots : "도어포켓 칸"
    refrigerator_slots ||..o{ ingredients : "재료 보관"
    tags ||..o{ ingredient_tags : "태그 연결"

    refrigerators {
        TEXT id PK
        TEXT name
    }

    refrigerator_rows {
        TEXT id PK
        TEXT refrigerator_id FK
        INTEGER sort_order
    }

    refrigerator_compartments {
        TEXT id PK
        TEXT row_id FK
        TEXT storage_mode "CHILLED / FROZEN"
        TEXT kind "HINGED / DRAWER"
        TEXT side "LEFT_DOOR / RIGHT_DOOR. 서랍형·공용은 NULL"
    }

    refrigerator_doors {
        TEXT id PK
        TEXT row_id FK
        TEXT compartment_id FK
        INTEGER sort_order
        INTEGER storage_enabled "0 / 1"
    }

    refrigerator_slots {
        TEXT id PK
        TEXT compartment_id FK "NULL 허용"
        TEXT door_id FK "NULL 허용"
        INTEGER sort_order
        INTEGER drawer_count "0 / 1 / 2"
    }

    ingredients {
        TEXT id PK
        TEXT name
        TEXT quantity "단위 포함 문자열"
        TEXT expiration_date "YYYY-MM-DD, NULL 허용"
        TEXT slot_id FK
        INTEGER drawer_number "분할 없음 0 / 왼쪽 1 / 오른쪽 2"
        TEXT memo "선택 입력, NULL 허용"
    }

    consumed_ingredients {
        TEXT id PK "기존 재료 UUID"
        TEXT name
        TEXT quantity
        TEXT expiration_date "YYYY-MM-DD, NULL 허용"
        TEXT slot_id "소비 당시 칸 UUID, FK 없음"
        INTEGER drawer_number "소비 당시 좌우 번호"
        TEXT memo "선택 입력, NULL 허용"
        TEXT consumed_at "UTC ISO 8601"
    }

    unassigned_ingredients {
        TEXT id PK "기존 재료 UUID"
        TEXT name
        TEXT quantity
        TEXT memo "NULL 허용"
        TEXT expiration_date "NULL 허용"
        TEXT slot_id "이전 칸 UUID, FK 없음"
        INTEGER drawer_number "이전 좌우 번호"
        INTEGER row_number
        INTEGER first_column
        INTEGER last_column
        INTEGER door_count
        INTEGER slot_number
        INTEGER is_body "0 / 1"
    }

    shopping_items {
        TEXT id PK
        TEXT name
        TEXT quantity
        TEXT created_at "UTC ISO 8601"
        TEXT memo "NULL 허용"
        TEXT purchased_at "UTC ISO 8601, NULL 허용"
    }

    tags {
        TEXT id PK
        TEXT name
        TEXT name_key UK "정규화한 이름"
    }

    ingredient_tags {
        TEXT ingredient_id PK "재료 UUID, FK 없음"
        TEXT tag_id PK,FK
    }
```

칸은 본체와 문 중 하나만 참조하며 도어포켓의 `drawer_count`는 `0`이다. 복합 키와 상세 제약은 [DB 테이블 구조](database-schema.md)를 따른다.

재료는 칸과 좌우 번호를 함께 참조한다. 도면 변경으로 위치가 사라지는 재료는 같은 UUID와 이전 위치 정보를 유지한 채 `unassigned_ingredients`로 옮긴다. 새 위치를 지정하면 `ingredients`로 다시 옮긴다.

소비 완료하면 기존 UUID와 정보를 `consumed_ingredients`로 옮긴다. 완료 기록은 칸을 외래 키로 참조하지 않아 구조 삭제 후에도 남으며, 복구 성공 시 `ingredients`로 다시 옮긴다.

`ingredient_tags.ingredient_id`는 외래 키 없이 세 재료 상태 테이블의 UUID를 참조한다. 상태를 옮길 때 태그 연결을 유지하며, 마지막 재료 기록을 삭제하면 연결도 삭제한다. `shopping_items`는 재료와 독립적으로 저장한다.
