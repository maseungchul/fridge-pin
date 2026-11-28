/**
 * @file
 * 도면·칸의 기한 상태별 재료 건수를 호출자가 정한 위치에 묶어 표시한다.
 * 홈은 세로·내부는 가로로 상태색을 연결하고, 범례는 숫자 없이 큰 상태 아이콘을 사용한다.
 */
import { StyleSheet, Text, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { Image } from 'expo-image';
import type { IngredientCounts } from '@/features/ingredient/model/ingredient';
import { useAppTheme } from '@/theme/ThemeProvider';
import { defaultTranslate } from '@/i18n/translations';
import type { Translator } from '@/i18n/translations';

export const INGREDIENT_BADGE_SIZE = 28;
const badgeKinds = ['normal', 'warning', 'expired', 'unknown'] as const;
// 도면에서 쓰는 상태 모양을 범례에서도 같은 SVG로 표시한다.
const badgeIcons = {
  normal: require('../../../../assets/ingredient-badge-normal.svg'),
  warning: require('../../../../assets/ingredient-badge-warning.svg'),
  expired: require('../../../../assets/ingredient-badge-expired.svg'),
  unknown: require('../../../../assets/ingredient-badge-unknown.svg'),
};

/** 색을 구별하지 못하는 경우에도 실제 건수와 기한 상태를 함께 안내한다. */
export function getIngredientCountLabel(counts: IngredientCounts, t: Translator = defaultTranslate) {
  return [t('counts.total', { count: counts.total }),
    ...(counts.normal > 0 ? [t('counts.normal', { count: counts.normal })] : []),
    ...(counts.warning > 0 ? [t('counts.warning', { count: counts.warning })] : []),
    ...(counts.expired > 0 ? [t('counts.expired', { count: counts.expired })] : []),
    ...(counts.unknown > 0 ? [t('counts.unknown', { count: counts.unknown })] : []),
  ].join(', ');
}

export function IngredientCountBadge({ count, kind, style }: {
  count?: number; kind: typeof badgeKinds[number]; style?: StyleProp<ViewStyle>;
}) {
  const { colors, ingredientBadgeColors } = useAppTheme();
  const backgroundColor = ingredientBadgeColors[kind];
  const color = colors.badgeText;
  const iconSize = count === undefined ? 24 : 22;
  return (
    <View style={[styles.badge, count === undefined && styles.legendBadge, { backgroundColor }, style]}>
      <Image source={badgeIcons[kind]} contentFit="contain" tintColor={color}
        style={[styles.icon, { width: iconSize, height: iconSize }]} accessible={false} />
      {count !== undefined ? (
        <Text style={[styles.count, { color }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6} maxFontSizeMultiplier={1}>{count > 99 ? '99+' : count}</Text>
      ) : null}
    </View>
  );
}

export function IngredientCountBadges({ counts, placement = 'center', direction = 'vertical', style }: {
  counts: IngredientCounts;
  placement?: 'center' | 'top-left' | 'top-right';
  direction?: 'vertical' | 'horizontal';
  style?: StyleProp<ViewStyle>;
}) {
  if (counts.total === 0) return null;
  const upper = placement !== 'center';
  const alignment = placement === 'top-right' ? 'flex-end' : 'flex-start';
  return (
    <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
      style={[styles.center, upper && { alignItems: alignment, justifyContent: 'flex-start' }, style]}>
      <View style={[styles.badges, direction === 'horizontal' && styles.horizontalBadges]}>
        {badgeKinds.filter(kind => counts[kind] > 0).map(kind => (
          <IngredientCountBadge key={kind} count={counts[kind]} kind={kind} />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
  badges: {
    maxWidth: '100%', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-start', gap: 2,
  },
  // 좁은 수납칸에서는 배지를 두 줄로 배치해 본체 너비에 영향을 주지 않는다.
  horizontalBadges: { width: '100%', flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-start' },
  badge: { width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  legendBadge: {
    width: INGREDIENT_BADGE_SIZE, height: INGREDIENT_BADGE_SIZE, borderRadius: INGREDIENT_BADGE_SIZE / 2,
    justifyContent: 'center',
  },
  icon: { flexShrink: 0 },
  count: { position: 'absolute', width: 15, textAlign: 'center', fontSize: 10, textAlignVertical: 'center',
    fontWeight: '700', fontVariant: ['tabular-nums'], includeFontPadding: false },
});
