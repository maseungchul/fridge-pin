/**
 * @file
 * 검색 결과와 이동 대기 목록에서 재료 위치의 경로를 공통 스타일로 표시한다.
 */
import { StyleSheet, Text, View } from 'react-native';
import { MaterialDesignIcons } from '@react-native-vector-icons/material-design-icons';
import { useAppTheme } from '@/theme/ThemeProvider';
import { createThemedStyles, spacing } from '@/theme/tokens';

export function IngredientLocationBreadcrumb({ path, sectionHeader = false }: {
  path: readonly string[]; sectionHeader?: boolean;
}) {
  const { mode, colors } = useAppTheme();
  const styles = getStyles(mode);

  return (
    <View accessible={sectionHeader || undefined} accessibilityRole={sectionHeader ? 'header' : undefined}
      accessibilityLabel={sectionHeader ? path.join(', ') : undefined} style={styles.location}>
      {path.map((part, index) => (
        <View key={index} style={styles.part}>
          {index > 0 ? <MaterialDesignIcons name="menu-right" size={16} color={colors.chilled} accessible={false} /> : null}
          <Text style={styles.text}>{part}</Text>
        </View>
      ))}
    </View>
  );
}

const getStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  location: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center',
    paddingHorizontal: spacing.md, paddingVertical: spacing.xs, backgroundColor: colors.chilledBackground },
  part: { flexDirection: 'row', alignItems: 'center', flexShrink: 1 },
  text: { color: colors.chilled, fontSize: 14, lineHeight: 21, fontWeight: '600', flexShrink: 1 },
}));
