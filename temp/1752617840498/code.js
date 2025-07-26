# Read input from stdin
input_data = input().strip()

# Parse array string: remove brackets and split by comma
arr = [int(x) for x in input_data[1:-1].split(',')]

# Find maximum element
max_element = max(arr)

# Output the result
print(max_element)